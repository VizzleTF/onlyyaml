---
title: 'Шпаргалка по Talos: команды, которые пригодятся'
summary: >-
  Подборка команд talosctl для обслуживания домашнего кластера: осмотр, логи,
  apply-config, upgrade, работа с etcd. Что безопасно, а что - нет.
date: Apr 20 2026
tags:
  - talos
  - kubernetes
  - cheatsheet
rss: >-
  Небольшая шпаргалка по talosctl: как посмотреть состояние нод, прочитать логи,
  обновить Talos и Kubernetes, безопасно править machine config через
  --mode=try, снять снапшот etcd и что вообще ни в коем случае не запускать на
  живом кластере.
seoTitle: 'Talos cheatsheet: talosctl команды для обслуживания Kubernetes-кластера'
seoDescription: >-
  Шпаргалка по Talos Linux: ключевые команды talosctl для домашнего
  Kubernetes-кластера. Экспорт talosconfig, осмотр, логи, apply-config с режимом
  try, upgrade с A/B-rollback, etcd snapshot, reset, reboot. С разделением на
  безопасные и деструктивные операции.
category: kubernetes
---

## Введение

В [прошлых](/blog/terraform-proxmox-talos/) [статьях](/blog/talos-longhorn/) мы подняли кластер на Talos через Terraform и накатили Longhorn. Кластер живой, но теперь его надо обслуживать: смотреть логи, обновлять ОС и Kubernetes, править конфиги, иногда - ребутить ноды.

`talosctl`-команды в предыдущих статьях разбросаны по тексту. Эта статья - шпаргалка, куда можно вернуться и быстро вспомнить нужную команду.

Важный момент: все команды идут через Talos API на порту `:50000`, никакого SSH в Talos нет. На каждую операцию `talosctl` нужен клиентский сертификат из `talosconfig`.

## Файлы и переменные окружения

После `terraform apply` из [предыдущей статьи](/blog/talos-longhorn/) в папке `_out/` лежат два файла:

- `talosconfig` - клиентский конфиг для `talosctl`. В нём CA кластера, клиентский сертификат, список endpoint-ов и nodes.
- `kubeconfig` - для `kubectl`. В этой статье не трогаем, но экспортировать удобно сразу.

Экспортируем:

```bash
export TALOSCONFIG=$PWD/_out/talosconfig
export KUBECONFIG=$PWD/_out/kubeconfig
```

Дальше все команды `talosctl` будут автоматически подхватывать этот конфиг. Альтернатива - передавать `--talosconfig _out/talosconfig` в каждой команде, но это быстро надоедает.

В `talosctl` есть два похожих по звучанию, но разных параметра:

- **endpoint** - нода, к которой подключается сам `talosctl` (`apid`).
- **node** - нода, на которой выполняется команда.

Можно сходить через CP-01, а команду выполнить против worker-05. Переопределяется в рамках одной команды флагами `--endpoints 192.168.1.101` и `--nodes 192.168.1.105`.

## Осмотреться в кластере

Команды, которые ничего не меняют.

```bash
talosctl version                # версия клиента и нод
talosctl health                 # проверка здоровья кластера
talosctl get members            # список нод по данным Talos
talosctl get machineconfig      # что реально применено на ноде
```

Если хочется смотреть на ноду живьём, есть `dashboard`:

```bash
talosctl dashboard --nodes 192.168.1.101
```

Это TUI с живыми метриками ноды: CPU, память, сеть, статусы сервисов, последние логи. Удобнее, чем бегать по отдельным `logs` и `top`.

> 💡 **Подробнее про ресурсы Talos** - `talosctl get --help`. Talos хранит состояние как CRD-подобные ресурсы: `members`, `nodeaddresses`, `services`, `hostname`, `routes` и так далее.


## Чтение и редактирование machine config

В статье про Longhorn machine config едет через провайдер `siderolabs/talos` и живёт в Terraform state. Но бывает, что нужно быстро посмотреть, что реально применено на ноде, или протестировать правку без `terraform apply`.

Читаем текущий конфиг:

```bash
talosctl get machineconfig -o yaml
talosctl get machineconfig -o yaml > node.yaml
```

## Обновление Talos

Talos держит две системных партиции - A и B. Upgrade пишет новый образ в соседний слот, ребутит в него, и если ядро не поднялось или health-check провалился - автоматически откатывается на старый слот. Поэтому апгрейд сам по себе не страшен, страшно - только делать несколько нод одновременно.

```bash
talosctl upgrade \
  --nodes 192.168.1.101 \
  --image factory.talos.dev/nocloud-installer/<schematic_id>:v1.9.0
```

Полезные флаги:

- `--preserve` - сохранить EPHEMERAL-партицию. На CP сохраняется по дефолту (там etcd), на воркерах - нужно явно указывать, иначе данные в `/var/lib/longhorn` улетят.
- `--stage` - записать образ, но применить при следующем ребуте.
- `--debug` - не возвращать control сразу, стримить логи апгрейда в консоль.

Последовательность на HA-кластере:

1. Обновляем одну ноду, дожидаемся `Ready` и зелёного статуса в Longhorn UI.
2. Только потом следующую.

> 💡 **Внимательно!** В кластере из 3 CP две одновременных перезагрузки убивают кворум etcd. Если в `controlplane.yaml` включён `allowSchedulingOnControlPlanes: true` и Longhorn с `defaultReplicaCount=2` - одновременный апгрейд двух нод оставит тома без живых реплик. Трогаем по одной.

## Смена образа

Если нужно добавить новое extension (скажем, `siderolabs/nvidia-container-toolkit`), рецепт из [статьи про Longhorn](/blog/talos-longhorn/) такой:

1. Добавляем extension в `talos_image_factory_schematic`.
2. `terraform apply` - получаем новый `schematic_id` и URL qcow2.
3. На работающих нодах ничего не меняется. Поле `machine.install.image` читается только при первой установке ОС, новый конфиг применится, но ребута не будет.
4. Чтобы действительно перекатить живые ноды - тот же `talosctl upgrade --image ...` с новым schematic.

Новые ВМ, созданные через модуль `vms` после смены schematic, сразу загрузятся с новым образом.

## Обновление Kubernetes

```bash
talosctl upgrade-k8s --to v1.31.4
```

- Обновляет control-plane компоненты (kube-apiserver, scheduler, controller-manager, kube-proxy) и kubelet на всех нодах.
- Саму ОС Talos не трогает. Для ОС - `talosctl upgrade`.
- Запускается один раз с любой CP-ноды, дальше обрабатывает весь кластер сам.

Под капотом он тоже идёт по нодам по очереди, ждёт готовности каждой и только потом берётся за следующую. Так что одной командой для всего кластера - это нормально.

## Ребут, shutdown, reset

Дальше пошли команды, на которых уже можно что-то сломать.

Ребут - относительно безопасно на HA:

```bash
talosctl reboot --nodes 192.168.1.101
talosctl reboot --nodes 192.168.1.101 --mode=powercycle
```

`--mode=powercycle` - жёсткий сброс без graceful shutdown. Нужен, когда graceful завис.

Shutdown - нода не поднимется сама:

```bash
talosctl shutdown --nodes 192.168.1.101
```

Reset - **destructive**. Стирает партиции и возвращает ноду в maintenance mode:

```bash
talosctl reset --nodes 192.168.1.101 --graceful --reboot
```

Флаги:

- `--graceful` (по умолчанию `true`) - Talos аккуратно покидает etcd перед wipe. Если это последняя CP с кворумом - команда зависнет в ожидании leader election. Тогда нужен `--graceful=false`.
- `--reboot` - после wipe перезагрузиться в maintenance mode (вместо shutdown).
- `--system-labels-to-wipe STATE,EPHEMERAL` - точечный wipe. Без флагов стирается всё.

> 💡 **Внимательно!** Reset убивает все Longhorn-реплики на ноде. Перед reset - заходим в Longhorn UI и убеждаемся, что все тома здоровы и реплицированы на оставшиеся ноды. Иначе получим `degraded` тома и долгий ребилд после того, как нода вернётся.

## Работа с etcd

Когда CP-нода померла насовсем (сдох диск, сгорел хост), её надо вручную убрать из etcd, иначе Talos будет считать кластер `degraded`.

```bash
talosctl etcd members                       # список участников с id
talosctl etcd remove-member <member-id>     # убрать дохлую
talosctl etcd forfeit-leadership            # отдать лидерство другой CP
talosctl etcd snapshot backup.db            # бэкап etcd в файл
```

`forfeit-leadership` удобно делать перед ребутом текущего лидера - чтобы не дожидаться переизбрания после того, как нода ушла в перезагрузку.

> 💡 **Подробнее про снапшоты.** `etcd snapshot` - по сути единственный способ сделать бэкап control-plane state в Talos. Никакого `etcdctl` на ноде нет, Talos immutable. Файл кладём куда-нибудь вне кластера, желательно в object storage.

## Bootstrap - ровно один раз

```bash
talosctl bootstrap --nodes 192.168.1.101
```

Вызывается **один раз** на первой CP при создании нового кластера. Повторный вызов на уже работающем кластере сломает etcd.

В [статье про Longhorn](/blog/talos-longhorn/) bootstrap делает ресурс `talos_machine_bootstrap` из Terraform-провайдера автоматически. Руками звать `talosctl bootstrap` на существующем кластере не нужно.

## Что безопасно, что деструктивно

Короткий свод, чтобы не думать каждый раз:

- **Safe (read-only)**: `version`, `health`, `get`, `logs`, `dmesg`, `read`, `services`, `containers`, `processes`, `disks`, `dashboard`, `support`, `etcd members`, `etcd snapshot`.
- **Безопасно с авто-откатом**: `apply-config --mode=try`, `upgrade` (A/B rollback), `upgrade-k8s` (откат компонентов при фейле).
- **Меняет состояние без отката**: `apply-config --mode=auto|reboot|staged`, `edit`, `etcd forfeit-leadership`.
- **Destructive, только осознанно**: `reboot`, `shutdown`, `etcd remove-member`.
- **Very destructive**: `reset` (wipe ноды), `bootstrap` на живом кластере.

## Заключение

Что полезного собрали в шпаргалке:

- **Экспорт `TALOSCONFIG`** - база, без которой `talosctl` вообще не работает.
- **Осмотр кластера** через `get`, `health` и `dashboard`.
- **Логи и диагностика** через `logs`, `dmesg` и бандл `support`.
- **`apply-config --mode=try`** - безопасные эксперименты с machine config.
- **Upgrade с A/B-rollback** - обновление Talos и Kubernetes без страха словить брикнутую ноду.
- **`etcd snapshot`** - единственный способ бэкапа control-plane state.

В следующих статьях поднимем поверх этого кластера ArgoCD и накроем всё GitOps-ом.

Мой боевой домашний конфиг с Talos-модулем лежит [тут](https://github.com/VizzleTF/home_proxmox/tree/main/terraform_proxmox).
