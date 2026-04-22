---
title: 'Шпаргалка по kubectl: алиасы для ежедневной работы с кластером'
summary: >-
  Набор kubectl-алиасов из моего .zshrc, переключение между несколькими
  kubeconfig, и команды вне алиасов - port-forward, rollout, dry-run, netshoot.
date: Apr 20 2026
tags:
  - kubernetes
  - cheatsheet
rss: >-
  Шпаргалка по kubectl для тех, кому надоело каждый раз набирать полную команду.
  Разбираю свой набор алиасов из .zshrc (kg, kd, ked, kdelp, klf и компания) +
  команды без алиасов - port-forward, rollout, kubectl diff, kubectl explain,
  netshoot для отладки сети.
seoTitle: 'kubectl cheatsheet: алиасы и команды для Kubernetes-оператора'
seoDescription: >-
  Шпаргалка по kubectl: готовый набор алиасов для zsh (kg, kd, ked, kdelp, klf и
  другие), переключение между несколькими kubeconfig через переменные окружения,
  команды для отладки - port-forward, rollout, logs, top, exec, kubectl diff,
  netshoot. С разделением на безопасные и деструктивные операции.
category: kubernetes
---

## Введение

В [прошлой статье](/blog/talos-cheatsheet/) собрали шпаргалку по `talosctl`. Логичное продолжение - `kubectl`, потому что после `talosctl bootstrap` и экспорта `KUBECONFIG` основная работа перемещается именно сюда.

> 💡 **ДИСКЛЕЙМЕР!** Копировать мои алиасы себе бездумно - абсолютно бесполезное и даже вредное занятие. Сперва нужно «прочувствовать» проблему, а только потом её решать. Это не весь список моих алиасов, и я знаю каждый из них. Ни один из них не лежит мёртвой строчкой в `.zshrc`.

## Полезные утилиты

| Утилита | Зачем |
| --- | --- |
| [`fzf`](https://github.com/junegunn/fzf) | Фаззи-поиск по любому потоку текста. На нём построены `kns`/`ktx`, интерактивный history и `Ctrl+T`/`Alt+C` в шелле. |
| [`kns` / `ktx`](https://github.com/blendle/kns) | Переключалки namespace и context через fzf. Подробнее - ниже отдельной секцией. |
| [`kubetail`](https://github.com/johanhaleby/kubetail) | Алиас `kt`. Склеивает логи всех подов сервиса в один поток с цветным префиксом. Подробнее - в секции про логи. |
| [`helm`](https://helm.sh) | Пакетный менеджер для Kubernetes. Charts, values, релизы, `upgrade`/`rollback`. |
| [`helmfile`](https://github.com/helmfile/helmfile) | Декларативная обвёртка над helm. В одном YAML описываешь все релизы кластера, `helmfile sync` приводит их к желаемому состоянию. |
| [`argocd`](https://argo-cd.readthedocs.io) | CLI к ArgoCD-серверу. Логин, sync приложений, просмотр status из пайплайна. |

## Работа с контекстом / неймспейсами

Писать каждый раз `-n <ns>` занятие крайне неэффективное. Тем более, что чаще всего работа происходит в одном ns, который периодически меняется. 
Для ускорения работы я использую переключение неймспейсов и контекстов через [kns](https://github.com/blendle/kns) от blendle. Он работает с локальным файлом kubeconfig и не дергает API-сервер - просто правит `current-context` и namespace. 

Установка через brew (`kns` и `ktx` лежат в одном tap):

```bash
brew tap blendle/blendle
brew install kns
```

Или руками, если brew нет - скрипты мелкие, из зависимостей только `fzf`:

```bash
curl -L https://raw.githubusercontent.com/blendle/kns/master/bin/kns -o /usr/local/bin/kns
curl -L https://raw.githubusercontent.com/blendle/kns/master/bin/ktx -o /usr/local/bin/ktx
chmod +x /usr/local/bin/{kns,ktx}
```

Запускаешь `kns` без аргументов - появляется fzf-список неймспейсов текущего кластера, выбираешь стрелками или набором - namespace становится дефолтным. Дальше `kgp`, `klf`, `kd` работают без `-n`.

> 💡 **Не путать с `kubens`** - `kns` (blendle) и `kubens` из [ahmetb/kubectx](https://github.com/ahmetb/kubectx) делают одно и то же, но это разные бинарники. `kubens` распиарен больше, `kns` - мельче, без лишних фич и с обязательным fzf.

## Базовые алиасы и автодополнение

Минимум, который должен быть у каждого уважающего себя девопса - чтобы `k` работал как `kubectl` с полным autocomplete. Это прямо рекомендует официальный [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/) - сама страница, кстати, и есть официальная kubectl-шпаргалка, к ней всегда можно вернуться за любой забытой командой.

```bash
# BASH - alias и completion для k
alias k=kubectl
complete -o default -F __start_kubectl k
```

```bash
# ZSH - completion через одну строку
source <(kubectl completion zsh)
```

Дальше - короткая ветка на основные команды:

```bash
alias k='kubectl'
alias kg='kubectl get'
alias kd='kubectl describe'
alias kdel='kubectl delete'
alias kaf='kubectl apply -f'
alias kex='kubectl exec'
alias kexi='kubectl exec -ti'
```

Всё остальное - уже специализация под конкретные ресурсы.

## GET - посмотреть, что запущено

Большая часть повседневной работы - это `kg <что-то>`. Для частых ресурсов - отдельные алиасы:

```bash
alias kgp='kubectl get pods -o wide'
alias kgsvc='kubectl get services'
alias kgsts='kubectl get statefulsets'
alias kgd='kubectl get deployments'
alias kgrs='kubectl get replicasets'
alias kgi='kubectl get ingress'
alias kgn='kubectl get nodes -o wide'
alias kgns='kubectl get namespaces'
alias kgpv='kubectl get pv'
alias kgpvc='kubectl get pvc'
alias kgcm='kubectl get configmaps'
alias kgsec='kubectl get secrets'
alias kgsa='kubectl get sa'
alias kgcert='kubectl get certificates'
alias kgj='kubectl get jobs'
alias kgcj='kubectl get cronjobs'
```

`kgp` и `kgn` идут с `-o wide`. Не было ни разу, чтобы оно мне как-то помешало.

Большинство моих алиасов это первые буквы команд, но есть и чуть более сложные, специфичные, например:

```bash
alias kgpp="kubectl get pod -o json | jq '.items[] | {pod: .metadata.name, containers: [.spec.containers[] | select(.ports != null) | {name: .name, ports: .ports}]} | select(.containers | length > 0)'"
```

Пользуюсь ей не часто, зато позволяет не крутить вывод `kdp <name>` или `kgp <name> -oyaml` в поисках нужного 

## DESCRIBE - более "человекочитаемый" вывод + почему не работает

Когда pod висит в `CrashLoopBackOff`, PVC - в `Pending`, а Ingress не раздаёт - первым делом `describe`. Секция `Events` в конце вывода обычно сразу объясняет, что пошло не так.

```bash
alias kdp='kubectl describe pods'
alias kdsvc='kubectl describe services'
alias kdsts='kubectl describe statefulsets'
alias kdd='kubectl describe deployments'
alias kdrs='kubectl describe replicasets'
alias kdi='kubectl describe ingress'
alias kdn='kubectl describe nodes'
alias kdpv='kubectl describe pv'
alias kdpvc='kubectl describe pvc'
alias kdcm='kubectl describe configmaps'
alias kdcert='kubectl describe certificates'
alias kdj='kubectl describe jobs'
alias kdcj='kubectl describe cronjobs'
```

Самый частый - `kdp <pod>`. Внизу увидишь `ImagePullBackOff`, `FailedMount`, `OOMKilled` или какой-нибудь `FailedScheduling: 0/5 nodes are available`. Дальше копать уже понятно в какую сторону.

## EDIT - быстро поправить на лету

`kubectl edit` открывает ресурс в редакторе и применяет изменения при сохранении. Редактор берётся из `$KUBE_EDITOR` или `$EDITOR`. У меня в `.zshrc`:

```bash
export KUBE_EDITOR=nano
```

Можете плеваться в меня за nano, у меня детская травма с VI, так что я его, по возможности, не использую.

```bash
alias kecm='kubectl edit configmap'
alias kesec='kubectl edit secret'
alias ked='kubectl edit deployment'
alias kei='kubectl edit ingress'
alias kecert='kubectl edit certificates'
alias kepv='kubectl edit pv'
alias kepvc='kubectl edit pvc'
alias kesvc='kubectl edit service'
alias kests='kubectl edit statefulset'
alias keditj='kubectl edit job'
alias keditcj='kubectl edit cronjob'
```

> 💡 **Внимательно!** Если ресурс разворачивается через ArgoCD, Flux или Terraform - `kubectl edit` применит изменения, но GitOps-контроллер через пару минут откатит их обратно к состоянию из репозитория. Edit - для быстрой отладки и проверки гипотез, не для постоянных правок.

## DELETE - осторожно

Удаление - самые деструктивные команды в списке. Защиты от `kdelp --all -A` в zsh нет, кроме собственной внимательности. 
Именно поэтому эти алиасы используют в центре 3 символа `del`, без сокращений, чтобы выполнять это только тогда, когда понимаешь, что делаешь.

```bash
alias kdelp='kubectl delete pod'
alias kdelsvc='kubectl delete service'
alias kdeld='kubectl delete deployment'
alias kdelrs='kubectl delete replicasets'
alias kdeli='kubectl delete ingress'
alias kdelpv='kubectl delete pv'
alias kdelpvc='kubectl delete pvc'
alias kdelcm='kubectl delete configmaps'
alias kdelj='kubectl delete job'
alias kdelcj='kubectl delete cronjob'
alias kdelcert='kubectl delete certificates'
alias kdelsec='kubectl delete secrets'
alias kdelns='kubectl delete namespace'
```


> 💡 **Внимательно!** `kdelns <namespace>` - эквивалент `rm -rf` для всего неймспейса. Удаляет все ресурсы внутри, включая PVC с данными. Плюс если namespace зависнет в `Terminating` из-за finalizer-ов на каком-нибудь CRD - снимать его руками через патчинг metadata. Всегда проверяем `kubectl config current-context` и `kgns` перед этой командой.

## Логи и exec

Логи - второй хлеб ежедневной работы после `kg`.

```bash
alias kl='kubectl logs'
alias klf='kubectl logs -f'
alias kt='kubetail'
```

`klf <pod>` - стрим логов одного pod.

Если у Deployment несколько реплик и непонятно, в какой именно проблема - `klf` покажет только одну. На этот случай есть `kt` - алиас на [kubetail](https://github.com/johanhaleby/kubetail), маленький bash-скрипт, который оборачивает `kubectl logs -f` по всем подходящим подам и склеивает их вывод:

```bash
kt nginx                 # логи всех подов, в имени которых есть "nginx"
kt -l app=nginx          # то же через label selector
```

Каждый pod получает свой цвет префикса, так что видно, от кого пришла строка. Очень выручает, когда ошибка воспроизводится не на всех репликах.

Exec - зайти внутрь контейнера:

```bash
alias kex='kubectl exec'
alias kexi='kubectl exec -ti'
```

`kexi <pod> -- sh` - стандартный способ «зайти в pod». Флаги `-ti` нужны, если собираешься что-то вводить с клавиатуры. Для одноразовых команд хватит `kex <pod> -- cat /etc/config.yaml` без них.

Если в образе нет `sh` (distroless, scratch) - поможет `kubectl debug`:

```bash
k debug <pod> -it --image=busybox --target=<container>
```

Создаёт sidecar с общим PID namespace, можно посмотреть процессы и файлы целевого контейнера.

## Top - кто жрёт ресурсы

`top` требует metrics-server в кластере. Без него команда падает с `Metrics API not available`.

```bash
alias ktp='kubectl top pod'
alias ktn='kubectl top node'
```

Полезные флаги в памяти держать не обязательно, но три самых частых:

- `--sort-by=memory` - отсортировать по потреблению памяти.
- `--containers` - разбивка по контейнерам внутри pod.
- `-A` - по всем namespace сразу.

`ktp -A --sort-by=memory | head` - классика для поиска виновника OOM.

## Команды вне алиасов

Не всё имеет смысл алиасить - есть команды, которые используются реже или всегда требуют свежих параметров.

Port-forward - когда нужно дотянуться до сервиса с ноутбука без Ingress:

```bash
k port-forward svc/myservice 8080:80
k port-forward pod/mypod 8080:80
```

Удобно для быстрой отладки - кидаешь порт наружу и коннектишься локально.

Rollout - история и откаты Deployment:

```bash
k rollout status deployment/nginx    # ждём, пока выкатится
k rollout history deployment/nginx   # история ревизий
k rollout undo deployment/nginx      # откат на предыдущую
k rollout restart deployment/nginx   # рестарт всех подов rolling-ом
```

`rollout restart` удобнее, чем удалять поды по одному - Kubernetes сам делает rolling update, выкидывает старые поды по одному и ждёт готовности новых.

Apply с dry-run - проверить, что манифест не сломает кластер:

```bash
k apply -f manifest.yaml --dry-run=server
k diff -f manifest.yaml
```

`--dry-run=server` отправляет манифест в API-сервер и прогоняет через admission-плагины, но не пишет в etcd. Ловит проблемы, которые клиентский `--dry-run=client` не видит - например, отказы ValidatingAdmissionWebhook от OPA/Kyverno.

`kubectl diff` показывает именно дельту между текущим состоянием и тем, что в файле. Нагляднее, чем читать весь YAML глазами.

Explain - встроенная документация по полям ресурсов:

```bash
k explain pod.spec.containers.resources
k explain deployment.spec.strategy --recursive
```

Быстрее, чем идти на kubernetes.io, и показывает именно ту версию API, которая в твоём кластере.

Netshoot - одноразовый pod для отладки сети:

```bash
k run tmp --rm -it --image=nicolaka/netshoot -- bash
```

В образе `nicolaka/netshoot` - `dig`, `curl`, `nslookup`, `tcpdump`, `ping`, `ip`, `mtr`. `--rm` удаляет pod после выхода. Незаменимо для отладки CoreDNS, NetworkPolicy и всяких «а почему из сервиса А сервис Б не резолвится».


## Заключение

Что собрали в шпаргалке:

- **`kns` и `ktx`** - быстрое переключение неймспейсов и контекстов через fzf, без дёрганья API-сервера.
- **Completion для `k`** - одна строка `source <(kubectl completion zsh)`, zsh сам прокидывает на алиас.
- **Сокращения для глаголов** - `kg`, `kd`, `kdel`, `ke*`, `kaf` вместо полных команд.
- **`kgp` и `kgn` с `-o wide`** - IP-адреса и версии сразу в выводе, без дописывания флага каждый раз.
- **`kgpp` через jq** - мгновенный список портов всех контейнеров в namespace.
- **`kt` через kubetail** - склеенные логи всех реплик Deployment с цветным префиксом.
- **Отдельная ветка на delete** - с явным именем ресурса, чтобы не снести лишнего.
- **Команды вне алиасов** - `port-forward`, `rollout`, `diff`, `explain`, `netshoot` для того, что алиасить нет смысла.
