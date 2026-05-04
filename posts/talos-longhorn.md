---
title: 'Prod-ready Kubernetes на Talos: Terraform, кастомный образ и Longhorn'
summary: >-
  Собираем кастомный образ Talos с iscsi-tools через Image Factory, накатываем
  его на ноды через провайдер siderolabs/talos и разворачиваем Longhorn.
date: Apr 20 2026
tags:
  - talos
  - longhorn
  - kubernetes
  - terraform
  - storage
  - infrastructure as code
rss: >-
  Talos + Longhorn - продолжение серии. Разбираемся, почему обычный образ Talos
  не подходит для Longhorn, собираем свой через Talos Image Factory, накатываем
  через провайдер siderolabs/talos и ставим Longhorn из Helm.
seoTitle: 'Prod-ready Kubernetes на Talos: Terraform, custom image, Longhorn storage'
seoDescription: >-
  Пошаговое руководство: как собрать кастомный образ Talos с iscsi-tools и
  util-linux-tools через Talos Image Factory, накатить его на ноды через
  Terraform-провайдер siderolabs/talos, настроить kubelet extraMounts и
  развернуть Longhorn из Helm.
category: kubernetes
---

## Введение

В [предыдущей статье](/blog/terraform-proxmox-talos/) мы развернули Kubernetes-кластер на Talos через Terraform и cloud-init.

В этой статье поднимем в нём distributed storage - Longhorn. Но прежде чем ставить его из Helm, придётся заменить образ Talos на кастомный и поправить machine config. А заодно переедем с cloud-init на провайдер `siderolabs/talos`, чтобы весь конфиг Talos жил в Terraform state.

## Какой кластер собираем

В статье собираем кластер из трёх нод. Все три - control-plane, отдельных worker-нод не заводим. Для домашней лабы это удачный формат: 3 машины нужны в любом случае (без них нет HA-кворума), а те же ноды спокойно тянут и workload, если снять дефолтный taint `NoSchedule` на CP. Никакой потери функциональности - Longhorn replica-ки, ingress-контроллеры, приложения живут прямо на control-plane нодах.

Разделение на CP и worker начинает окупаться, когда control-plane перестаёт справляться - обычно это большие кластеры на сотни подов, а не homelab. В конце статьи есть отдельная секция про то, как добавить worker-ноды, когда понадобится.

**Почему именно 3 ноды**. Control-plane работает поверх etcd, а etcd - это кворумный протокол Raft. Чтобы кластер принимал изменения, нужно большинство живых нод: `(N/2)+1`. Отсюда арифметика:

- **1 нода** - HA нет. Упала - лёг весь кластер.
- **2 ноды** - хуже, чем 1. Кворум 2, любой сбой валит кластер.
- **3 ноды** - кворум 2, переживаем падение одной. Минимум для HA.
- **5 нод** - кворум 3, переживаем две. Для серьёзных инсталляций.
- **Чётные числа** - переживают столько же, сколько нечётное на 1 меньше.

3 ноды - стандарт для homelab. Хватает для HA, etcd не шумит лишним трафиком репликации, и остаётся запас на обслуживание одной ноды.

## Почему не работает стандартный образ

Longhorn хранит данные как iSCSI-таргеты и управляет ими через `iscsiadm`. Ещё он ходит в mount namespace хоста через `nsenter`. На обычном Linux эти утилиты ставятся из пакетов `open-iscsi` и `util-linux`.

А Talos - immutable OS. Пакетного менеджера нет, SSH тоже нет. Всё, что есть в системе, зашито в образ.

Если попробовать поставить Longhorn на стандартный образ, поды `longhorn-manager` будут падать с ошибками про отсутствующие бинарники, а PVC останутся висеть в `Pending`.

## Talos Image Factory

Для таких случаев есть [factory.talos.dev](https://factory.talos.dev) - сервис, который собирает кастомные образы Talos с нужными extensions. Мы описываем список extensions, получаем `schematic_id` (айди образа с нужными расширениями), и дальше URL к любому образу этого schematic собирается детерминированно.

Для Longhorn нам нужны две официальные extensions:

- `siderolabs/iscsi-tools` - даёт `iscsiadm` и стек open-iscsi.
- `siderolabs/util-linux-tools` - даёт `nsenter` и остальные утилиты из util-linux.

Можно добавить ещё `siderolabs/qemu-guest-agent` - он не обязателен для Longhorn, но на Proxmox must have: IP ВМ виден в UI, корректный guest shutdown.

## Переезд на провайдер siderolabs/talos

В прошлой статье мы клали сгенерированные `talosctl gen config`-ом файлы в cloud-init snippets, а первую ноду бутстрапили руками. Это работает, но секреты кластера лежат на диске в `_out/`, bootstrap не воспроизводится через `terraform apply`, а сменить образ на кастомный - отдельный квест.

Провайдер [siderolabs/talos](https://registry.terraform.io/providers/siderolabs/talos/latest) всё это решает. Он умеет генерить секреты кластера, собирать machine config, накатывать его через Talos API и делать bootstrap первой ноды. Всё внутри одного `terraform apply`.

> **Ограничение провайдера:** обновление самой ОС Talos (не Kubernetes) провайдер не делает. Для этого остаётся `talosctl upgrade` на каждую ноду.

## Настройка провайдера

Базу берём из прошлых статей серии - модули `cloud_images` и `vms` уже есть в проекте. Добавляем к ним новый модуль `talos`. В итоге структура проекта будет выглядеть так:

```
terraform_proxmox/
├── configs/
│   └── vms.yaml                    # описание ВМ для модуля vms
├── modules/
│   ├── cloud_images/               # из статьи «Создание модулей Terraform»
│   ├── vms/                        # из статьи «Terraform + Proxmox»
│   └── talos/                      # собираем в этой статье
│       ├── provider.tf             # провайдеры модуля: talos, proxmox
│       ├── variables.tf            # входные переменные модуля
│       ├── schematic.tf            # schematic + URL образа + output
│       ├── secrets.tf              # machine secrets + talosconfig
│       ├── configs.tf              # machine_configuration для CP и worker
│       ├── apply.tf                # apply + bootstrap + kubeconfig
│       └── patches/
│           ├── common.yaml         # install, kubelet extraMounts, kernel
│           └── controlplane.yaml   # VIP + allowSchedulingOnControlPlanes
├── provider.tf                     # корневой провайдер, из первой статьи
├── cloud_images.tf                 # обновим в этой статье
├── vm_resources.tf                 # вызов module "vms", из статьи про модули
└── talos.tf                        # создадим в этой статье
```

Заводим папку `modules/talos`, в ней файл `modules/talos/provider.tf`:

```hcl
terraform {
  required_providers {
    talos = {
      source  = "siderolabs/talos"
      version = "~> 0.9"
    }
    proxmox = {
      source = "bpg/proxmox"
    }
  }
}
```

## Сборка schematic

Создаём файл `modules/talos/schematic.tf`:

```hcl
resource "talos_image_factory_schematic" "this" {
  schematic = yamlencode({
    customization = {
      systemExtensions = {
        officialExtensions = [
          "siderolabs/iscsi-tools",
          "siderolabs/util-linux-tools",
          "siderolabs/qemu-guest-agent",
        ]
      }
    }
  })
}

data "talos_image_factory_urls" "this" {
  talos_version = var.talos_version
  schematic_id  = talos_image_factory_schematic.this.id
  platform      = "nocloud"
}

output "disk_image_url" {
  value = replace(
    data.talos_image_factory_urls.this.urls.disk_image,
    ".raw.xz",
    ".qcow2",
  )
}
```

`talos_image_factory_schematic` регистрирует schematic на factory.talos.dev и возвращает его id. Id получается детерминированно из содержимого yaml-а: тот же набор extensions даёт тот же id, новый apply не будет пересоздавать ресурс.

`talos_image_factory_urls` отдаёт нам две вещи:

- `urls.installer` - ссылка на installer-образ, пойдёт в `machine.install.image` в конфиге Talos и останется внутри модуля.
- `urls.disk_image` - ссылка на disk-образ для платформы. Тут есть нюанс: для `nocloud` data source отдаёт `.raw.xz`, а Proxmox-импорту удобнее qcow2. Аргумента выбора формата у data source нет, но factory по той же схеме URL раздаёт и qcow2 - отличие ровно в расширении. Поэтому через `replace(..., ".raw.xz", ".qcow2")` получаем qcow2-URL, не дублируя ни домен, ни путь, ни архитектуру: единственный источник правды остаётся в data source. Пробрасываем результат наружу через `output` - дальше он понадобится в корне проекта в модуле `cloud_images`.

Создаём файл `modules/talos/variables.tf` с переменными модуля:

```hcl
variable "talos_version" {
  description = "Talos release tag, напр. v1.9.0"
  type        = string
  default     = "v1.9.0"
}

variable "cluster_name" {
  description = "Имя кластера"
  type        = string
}

variable "cluster_endpoint" {
  description = "Endpoint кластера, напр. https://192.168.1.100:6443"
  type        = string
}

variable "nodes" {
  description = "Ноды кластера: ключ - hostname, значение - address и role"
  type = map(object({
    address = string
    role    = string
  }))
}
```

Остальные переменные (`cluster_name`, `cluster_endpoint`, `nodes`) понадобятся дальше, но удобнее завести их сразу - чтобы `variables.tf` не пришлось дописывать в каждой секции.

## Корневой вызов модуля

Вызываем модуль из корня проекта. Создаём файл `talos.tf`:

```hcl
module "talos" {
  source = "./modules/talos"

  cluster_name     = "talos-proxmox-cluster"
  cluster_endpoint = "https://192.168.1.100:6443"

  nodes = {
    "talos-cp-01" = { address = "192.168.1.101", role = "controlplane" }
    "talos-cp-02" = { address = "192.168.1.102", role = "controlplane" }
    "talos-cp-03" = { address = "192.168.1.103", role = "controlplane" }
  }
}
```

Все адреса и имена - свои, подставьте под свою сеть. Имя кластера попадёт в CA-сертификаты, потом его будет неудобно менять.

Теперь про `cluster_endpoint`. Это адрес, на который ходит `kubectl`, kubelet-ы и любые клиенты kube-API. В нашем примере `192.168.1.100:6443` - и это не адрес какой-то ноды, а **VIP** (Virtual IP адрес).

VIP - это один IP, который «плавает» между control-plane нодами. Адрес принадлежит кластеру, а не железке. В каждый момент времени им владеет ровно одна CP-нода, остальные молчат. Если нода-владелец умерла, следующая CP подхватывает IP, и клиенты продолжают ходить по тому же адресу, даже не заметив переключения.

Под капотом в Talos это сделано через etcd: CP-ноды выбирают лидера, лидер объявляет IP на своём интерфейсе через gratuitous ARP, остальные слушают. При падении лидера - новый выбор, новый gratuitous ARP, свитч в локальной сети обновляет MAC-таблицу.

## Скачиваем образ в Proxmox

Берём модуль `cloud_images` из [предыдущей статьи](/blog/terrafom-modules/) и подставляем URL из модуля `talos`. Редактируем корневой файл `cloud_images.tf`:

```hcl
module "cloud_images" {
  source = "./modules/cloud_images"

  images_config = {
    global = {
      node_name    = "pve1"
      datastore_id = "local-lvm"
    }
    images = {
      "talos-longhorn" = {
        enabled      = true
        content_type = "import"
        url          = module.talos.disk_image_url
        file_name    = "talos-longhorn.qcow2"
      }
    }
  }
}
```

Если потом надо будет добавить ещё extensions, меняем `schematic`, получаем новый `schematic_id`, новый qcow2 подтянется автоматически. Но сам по себе `terraform apply` живые ноды не перевыпустит - и это хорошо.

Поле `machine.install.image` в Talos читается только при первой установке ОС. На уже запущенной ноде оно просто лежит в state: Terraform увидит diff в конфиге, накатит его через `talos_machine_configuration_apply` - но это no-op для работающей системы, ребута не будет. Новые ВМ, созданные через модуль `vms`, загрузятся с новым образом, а существующие продолжат жить со старым.

Чтобы действительно обновить расширения на работающих нодах, нужен `talosctl upgrade`:

```bash
talosctl upgrade \
  --nodes 192.168.1.101 \
  --image factory.talos.dev/nocloud-installer/<new_schematic_id>:v1.9.0
```

Команда делает контролируемый ребут через A/B-партиции Talos: новый образ пишется в соседний слот, нода перезагружается в него, и если не поднялась - автоматический откат на предыдущий. Данные Longhorn на `/var/lib/longhorn` при этом не трогаются, EPHEMERAL-партиция сохраняется между апгрейдами.

> **Обновляйте ноды по одной.** При ребуте одной CP Longhorn теряет replica на ней, но том продолжает отдаваться с двух оставшихся (`defaultReplicaCount=2` + 3 ноды). Когда нода вернулась - replica ребилдится и становится `Healthy`. Следующую трогать только после того, как Longhorn UI покажет все тома зелёными - иначе два одновременных ребута могут оставить том без живых реплик.

## Поднимаем ВМ

Прежде чем накатывать Talos-конфиг, нужны сами ВМ. Создаём их через модуль `vms` из [первой статьи серии](/blog/terraform-proxmox/) - он принимает YAML с описанием машин и разворачивает их в Proxmox из скачанного qcow2.

Добавляем в `configs/vms.yaml` три ноды:

```yaml
tags:
  - terraform
  - talos
vms:
  talos-cp-01:
    node_name: "pve1"
    enabled: true
    vm_id: 401
    address: "192.168.1.101/24"
    image_file: "local-lvm:import/talos-longhorn.qcow2"
    os_type: "l26"
    cores: 4
    ram: 8192
    disk_size: 50
  talos-cp-02:
    node_name: "pve1"
    enabled: true
    vm_id: 402
    address: "192.168.1.102/24"
    image_file: "local-lvm:import/talos-longhorn.qcow2"
    os_type: "l26"
    cores: 4
    ram: 8192
    disk_size: 50
  talos-cp-03:
    node_name: "pve1"
    enabled: true
    vm_id: 403
    address: "192.168.1.103/24"
    image_file: "local-lvm:import/talos-longhorn.qcow2"
    os_type: "l26"
    cores: 4
    ram: 8192
    disk_size: 50
```

В отличие от прошлой статьи, тут нет `user_data_file_id` - cloud-init больше не нужен. Весь конфиг Talos приедет через провайдер напрямую по API.

Самое важное - адреса в `address` должны совпадать с теми, что лежат в `nodes` в `talos.tf`. По этим IP провайдер Talos будет стучаться к нодам для apply и bootstrap. Несовпадение - и `terraform apply` зависнет на попытке применить конфиг на несуществующий адрес.

После `terraform apply` ВМ стартуют с кастомного qcow2 и поднимаются в **maintenance mode**. Это режим свежеустановленного Talos: ядро загружено, `apid` слушает на `:50000`, но ни etcd, ни kubelet ещё не запущены - нода просто ждёт, когда по сети прилетит machine config.

Следующими шагами `talos_machine_configuration_apply` и `talos_machine_bootstrap` это и сделают: провайдер пройдётся по IP из `nodes`, отправит каждой ноде её конфиг, затем дёрнет bootstrap на первой CP. Ноды забутстрапят etcd, поднимут kubelet - и из maintenance-mode превратятся в полноценный кластер.

## Secrets и talosconfig

Создаём файл `modules/talos/secrets.tf`:

```hcl
resource "talos_machine_secrets" "this" {
  talos_version = var.talos_version
}

data "talos_client_configuration" "this" {
  cluster_name         = var.cluster_name
  client_configuration = talos_machine_secrets.this.client_configuration
  endpoints            = [for n in var.nodes : n.address if n.role == "controlplane"]
  nodes                = [for n in var.nodes : n.address]
}

resource "local_sensitive_file" "talosconfig" {
  content  = data.talos_client_configuration.this.talos_config
  filename = "${path.root}/_out/talosconfig"
}
```

`talos_machine_secrets` генерит CA, bootstrap token и сертификаты, а потом хранит их в Terraform state.

> **Внимательно!** Если используете удалённый backend (S3, Terraform Cloud) - убедитесь, что он с шифрованием. Локальный `terraform.tfstate` с секретами кластера в git - плохая идея.

## Machine config для Longhorn

Тут самая важная часть статьи. Longhorn складывает data replicas в `/var/lib/longhorn`. В Talos этот путь надо явно прокинуть kubelet-у через `extraMounts`, иначе CSI-драйверу некуда будет писать.

Создаём подпапку `modules/talos/patches/` и в ней файл `common.yaml`:

```yaml
machine:
  install:
    disk: /dev/sda
    image: ${install_image}
    wipe: false
  kubelet:
    extraMounts:
      - destination: /var/lib/longhorn
        type: bind
        source: /var/lib/longhorn
        options:
          - bind
          - rshared
          - rw
  kernel:
    modules:
      - name: nvme_tcp
```

`rshared` в options - это флаг mount propagation. Без него Longhorn CSI не увидит изменения в маунтах, сделанных внутри подов, и при снапшотах будет ругаться на «mount not found».

`kernel.modules` с `nvme_tcp` нужен только если планируете трогать Longhorn V2 Data Engine. Для классического V1 на iSCSI можно не включать.

> **Подробнее про `extraMounts`** в документации Talos: [Kubelet Configuration](https://www.talos.dev/latest/reference/configuration/v1alpha1/config/#Config.machine.kubelet.extraMounts).

> **Официальный гайд Longhorn по Talos** со всеми data-path mount-ами и объяснением, зачем они нужны: [Talos Linux Support](https://longhorn.io/docs/archives/1.7.3/advanced-resources/os-distro-specific/talos-linux-support/#data-path-mounts).

## Патч для control-plane с VIP

Раз `cluster_endpoint` - это VIP, надо сказать Talos-у, как его поднимать. VIP в Talos живёт в конфиге сетевого интерфейса control-plane нод. Создаём файл `modules/talos/patches/controlplane.yaml`:

```yaml
machine:
  network:
    interfaces:
      - interface: eth0
        dhcp: false
        vip:
          ip: 192.168.1.100
cluster:
  allowSchedulingOnControlPlanes: true
  apiServer:
    admissionControl:
      - name: PodSecurity
        configuration:
          apiVersion: pod-security.admission.config.k8s.io/v1
          kind: PodSecurityConfiguration
          defaults:
            enforce: privileged
            audit: restricted
            warn: restricted
```

Что делает каждая строчка:

| Строка | Что делает |
| --- | --- |
| `interface: eth0` | основной интерфейс ноды |
| `dhcp: false` | адрес статикой - DHCP не накидывает лишних |
| `vip.ip` | shared-IP под kube-apiserver, плавает между CP |
| `allowSchedulingOnControlPlanes: true` | снимает taint `node-role.kubernetes.io/control-plane:NoSchedule` - workload-поды едут на CP |
| `admissionControl[0].name: PodSecurity` | переопределяем Talos-овский дефолт `enforce: baseline` (на нём Longhorn режется) |
| `enforce: privileged` | ничего не блокируется - privileged-поды стартуют без лейблов на namespace |
| `warn: restricted` / `audit: restricted` | apiserver всё равно проверяет под на `restricted` и при нарушении пишет warning + audit log |

`exemptions` не указываем: Talos уже дефолтно даёт `namespaces: [kube-system]`, и повторное перечисление через strategic merge даст дубликат - kube-apiserver упадёт с `exemptions.namespaces[1]: Duplicate value`.

Для прода такая раздача `privileged` всему кластеру не катит - там привычнее `enforce: baseline` плюс точечный exemption на `longhorn-system`. Для хоумлаба «всё работает + warning-и видны» - нормальный компромисс.

Патч прикладываем только к CP - воркерам VIP не нужен, а `cluster.*` Talos на воркерах и так игнорирует.

> **IP-адрес** в yaml-е захардкожен под пример статьи. Подставьте свой VIP из той же подсети, что и ноды, и этот же адрес укажите в `cluster_endpoint`.

## Собираем конфиги нод

Создаём файл `modules/talos/configs.tf`:

```hcl
locals {
  common_patch = templatefile("${path.module}/patches/common.yaml", {
    install_image = data.talos_image_factory_urls.this.urls.installer
  })
  controlplane_patch = file("${path.module}/patches/controlplane.yaml")
}

data "talos_machine_configuration" "controlplane" {
  cluster_name     = var.cluster_name
  cluster_endpoint = var.cluster_endpoint
  machine_type     = "controlplane"
  machine_secrets  = talos_machine_secrets.this.machine_secrets
  talos_version    = var.talos_version
  docs             = false
  examples         = false

  config_patches = [
    local.common_patch,
    local.controlplane_patch,
  ]
}

data "talos_machine_configuration" "worker" {
  cluster_name     = var.cluster_name
  cluster_endpoint = var.cluster_endpoint
  machine_type     = "worker"
  machine_secrets  = talos_machine_secrets.this.machine_secrets
  talos_version    = var.talos_version
  docs             = false
  examples         = false

  config_patches = [local.common_patch]
}
```

CP получает оба патча, воркер - только `common.yaml`. Благодаря этому VIP объявляется только на нужных нодах.

Флаги `docs = false` и `examples = false` убирают из итогового yaml-а комментарии и примеры. Конфиг становится компактнее и лучше диффится в state.

## Применение конфига и bootstrap

Создаём файл `modules/talos/apply.tf`:

```hcl
resource "talos_machine_configuration_apply" "this" {
  for_each = var.nodes

  client_configuration = talos_machine_secrets.this.client_configuration
  machine_configuration_input = each.value.role == "controlplane" ? (
    data.talos_machine_configuration.controlplane.machine_configuration
  ) : (
    data.talos_machine_configuration.worker.machine_configuration
  )
  node = each.value.address

  config_patches = [
    yamlencode({
      machine = {
        network = {
          hostname = each.key
        }
      }
    })
  ]

  depends_on = [module.vms]
}

resource "talos_machine_bootstrap" "this" {
  client_configuration = talos_machine_secrets.this.client_configuration
  node                 = [for n in var.nodes : n.address if n.role == "controlplane"][0]

  depends_on = [talos_machine_configuration_apply.this]
}

data "talos_cluster_kubeconfig" "this" {
  client_configuration = talos_machine_secrets.this.client_configuration
  node                 = [for n in var.nodes : n.address if n.role == "controlplane"][0]

  depends_on = [talos_machine_bootstrap.this]
}

resource "local_sensitive_file" "kubeconfig" {
  content  = data.talos_cluster_kubeconfig.this.kubeconfig_raw
  filename = "${path.root}/_out/kubeconfig"
}
```

Per-node patch с hostname-ом передаём прямо в `config_patches`. Отдельные файлы на каждую ноду не нужны.

Выполняем `terraform plan`, убеждаемся, что создастся schematic, все ресурсы talos_* и local-файлы с конфигами, и применяем:

```bash
terraform apply
```

## Проверяем кластер

В `_out/` должны появиться `talosconfig` и `kubeconfig`. Экспортируем их:

```bash
export TALOSCONFIG=$PWD/_out/talosconfig
export KUBECONFIG=$PWD/_out/kubeconfig

kubectl get nodes
```

И видим:

```
NAME           STATUS   ROLES           AGE   VERSION
talos-cp-01    Ready    control-plane   3m    v1.31.0
talos-cp-02    Ready    control-plane   3m    v1.31.0
talos-cp-03    Ready    control-plane   3m    v1.31.0
```

Отлично, кластер живой. Можно ставить Longhorn.

> **Если ноды висят в `NotReady`** или kubelet жалуется на сертификаты - проверьте pending CSR:
>
> ```bash
> kubectl get csr
> ```
>
> Если в выводе есть строки со статусом `Pending` - заапрувим всё одной командой:
>
> ```bash
> kubectl get csr -o name | xargs kubectl certificate approve
> ```
>
> После этого ноды добивают handshake с api-server-ом и переходят в `Ready`.

## Установка Longhorn

В данном примере будем устанавливать Longhorn через Helm-чарт с дефолтными вельюсами, кроме числа реплик: вместо дефолтных `3` оставим `2` (можно переопределить для каждого вольюма по отдельности после):

```bash
helm repo add longhorn https://charts.longhorn.io
helm repo update

helm install longhorn longhorn/longhorn \
  --namespace longhorn-system --create-namespace \
  --set persistence.defaultClass=true \
  --set persistence.defaultClassReplicaCount=2 \
  --set defaultSettings.defaultReplicaCount=2
```

Смотрим, что всё поднялось:

```bash
kubectl -n longhorn-system get pods
```

Должны быть в `Running` поды `longhorn-manager-*` (по одному на ноде), `longhorn-driver-deployer-*`, `csi-*`, `engine-image-ei-*` и `instance-manager-*`.

Проверяем, что StorageClass создался и стал дефолтным:

```bash
kubectl get storageclass
```

```
NAME                 PROVISIONER          RECLAIMPOLICY   ...
longhorn (default)   driver.longhorn.io   Delete          ...
```

## Проверка: PVC + Pod

Создаём файл `test.yaml`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: longhorn-test
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: longhorn-test
spec:
  containers:
    - name: writer
      image: alpine:3.20
      command: ["sh", "-c", "echo 'longhorn works' > /data/hello.txt && sleep 3600"]
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: longhorn-test
```

Применяем и проверяем:

```bash
kubectl apply -f test.yaml
kubectl get pvc
```

```
NAME            STATUS   VOLUME        CAPACITY   STORAGECLASS   AGE
longhorn-test   Bound    pvc-abc...    1Gi        longhorn       10s
```

`Bound` за несколько секунд. Читаем файл из тома:

```bash
kubectl exec longhorn-test -- cat /data/hello.txt
# longhorn works
```

Работает! Убираем за собой:

```bash
kubectl delete -f test.yaml
```

## Добавляем worker-ноды

Если 3 нод перестаёт хватать - значит пришло время добавлять воркер ноды. Не стоит добавлять больше контрол плейн нод, т.к. будем много трафика етсд, а отказоустойчивости в 1 ноду должно быть больше чем достаточно. Добавляем в `nodes` записи с ролью `worker`:

```hcl
nodes = {
  "talos-cp-01" = { address = "192.168.1.101", role = "controlplane" }
  "talos-cp-02" = { address = "192.168.1.102", role = "controlplane" }
  "talos-cp-03" = { address = "192.168.1.103", role = "controlplane" }
  "talos-wk-01" = { address = "192.168.1.104", role = "worker" }
  "talos-wk-02" = { address = "192.168.1.105", role = "worker" }
}
```

`terraform apply` создаст ВМ (необходимо поднять ВМ через модуль `vms` из [прошлой статьи](/blog/terrafom-modules/)), сгенерит для них machine config и накатит через `talos_machine_configuration_apply` - ноды сами войдут в кластер. Никакого ручного `talosctl apply` или `kubeadm join` делать не нужно.

Разница между CP и worker в нашей схеме:

- **Тип машины**: CP генерится из `data.talos_machine_configuration.controlplane` - со всем control-plane стеком (etcd, kube-apiserver, kube-scheduler, kube-controller-manager). Воркер получает `worker` с минимальным набором: kubelet + kube-proxy.
- **Патчи**: CP получает `common.yaml` + `controlplane.yaml`. Воркер - только `common.yaml`. Всё из `cluster.*` (в том числе `allowSchedulingOnControlPlanes`) и VIP живёт только на CP.
- **Bootstrap**: `talos_machine_bootstrap` дёргается ровно один раз - на самой первой CP. Остальные CP и все воркеры присоединяются к уже работающему etcd-кластеру автоматически.
- **Taint и scheduling**: с `allowSchedulingOnControlPlanes: true` (как в нашей статье) поды едут и на CP, и на воркеры - планировщик выбирает свободный узел. Если флаг выключить - CP получает обратно taint `NoSchedule`, и workload идёт только на воркеры.

Когда воркеры появились и хочется держать control-plane «чистым», убираем `allowSchedulingOnControlPlanes: true` из `controlplane.yaml`. Longhorn-replica-ки при следующем rebuild переедут на воркеры сами.

Отдельный момент: ещё одна CP-нода добавляется ровно так же, одной строкой в map-е. Но помните про арифметику etcd из начала статьи - расти стоит сразу с 3 до 5, промежуточных значений `4` в мире Raft не бывает.

## Заключение

Мы собрали свой Kubernetes-кластер с distributed storage, полностью через Terraform. Что у нас получилось:

- **Кастомный образ Talos** с `iscsi-tools` и `util-linux-tools`, собранный через Talos Image Factory.
- **Переезд на провайдер `siderolabs/talos`**: секреты, machine config и bootstrap живут в Terraform state, а не на диске.
- **Bind-mount для Longhorn**: `/var/lib/longhorn` прокинут в kubelet с `rshared` mount propagation.
- **Рабочий Longhorn** с дефолтным StorageClass, PVC создаются за секунды.

В следующих статьях разберём, как добавить сюда бэкапы на S3, кастомные StorageClass под разные профили и GitOps через ArgoCD.

Мой боевой домашний конфиг с этим модулем лежит [тут](https://github.com/VizzleTF/home_proxmox/tree/main/terraform_proxmox).
