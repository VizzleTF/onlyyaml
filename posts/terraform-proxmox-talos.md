---
title: 'Terraform + Proxmox + Talos: Kubernetes кластер через IaC'
summary: >-
  Развертывание Kubernetes кластера на Talos Linux в Proxmox через Terraform.
  Автоматизация создания нод и конфигурации.
date: Sep 21 2025
tags:
  - proxmox
  - terraform
  - talos
  - kubernetes
  - infrastructure as code
rss: >-
  Развертываем Kubernetes кластер на Talos Linux в Proxmox через Terraform.
  Полная автоматизация от создания VM до готового кластера с помощью
  Infrastructure as Code!
seoTitle: 'Terraform Proxmox Talos: Автоматизация Kubernetes кластера через IaC'
seoDescription: >-
  Пошаговое руководство по развертыванию Kubernetes кластера на Talos Linux в
  Proxmox VE через Terraform. Настройка cloud-init, создание модулей,
  автоматизация конфигурации нод и bootstrap кластера с помощью Infrastructure
  as Code.
category: gitops
---

## Введение

После настройки модулей можно приняться за инфраструктуру. Почему бы не начать с самого интересного? Давайте развернем Kubernetes! А чтобы было не слишком скучно, сделаем это через Terraform в Proxmox, используя Talos nocloud образ с конфигурацией через cloud-init, а не через команды в консоли (хотя одну ноду для bootstrap все же придется настроить вручную).

## Подготовка образа Talos

Находим подходящий образ на https://factory.talos.dev/

Выбираем последовательно:
- Cloud server
- Последнюю версию (1.11.1)
- Nocloud
- amd64 (или arm64, в зависимости от платформы)
- siderolabs/qemu-guest-agent
- Без кастомизации

В конце видим, что нам предлагают скачать либо raw.xz, либо .iso — оба варианта не очень удобны. Поэтому берем ссылку и меняем расширение на .qcow2. Должно получиться примерно так:
`https://factory.talos.dev/image/ce4c980550dd2ab1b17bbf2b08801c7eb59418eafe8f279833297925d67c7515/v1.11.1/nocloud-amd64.qcow2`

Вставляем в наш конфиг cloud images:
```yaml
global:
  node_name: "pve1"
  datastore_id: "memini"
  upload_timeout: 3600
  overwrite: false

images:
  talos-nocloud:
    enabled: false
    content_type: "import"
    url: "https://factory.talos.dev/image/ce4c980550dd2ab1b17bbf2b08801c7eb59418eafe8f279833297925d67c7515/v1.11.1/nocloud-amd64.qcow2"
    file_name: "talos-nocloud-1.11.1.qcow2"
```

Выполняем `terraform plan`, убеждаемся, что Terraform предлагает создать наш образ, и применяем изменения командой `terraform apply`.

## Настройка нод кластера

### Конфигурация первой мастер ноды

Создаем конфигурацию для первой ноды Kubernetes кластера:
```yaml
global:
  node_name: "pve1"
  datastore_id: "local-lvm"
  gateway: "192.168.1.1"
  dns_servers: ["1.1.1.1"]
  cores: 2
  ram: 2048
  disk_size: 20
  pool_id: null
  boot_order: ["sata0"]
  startup_order: 2
  startup_up_delay: 5
  cpu_type: "host"
  network_bridge: "vmbr0"
  os_type: "l26"

tags:
  - terraform

vms:
  talos-cp-01:
    node_name: "pve3"
    enabled: true
    vm_id: 400
    address: "192.168.1.101/24"
    tags: ["talos", "kubernetes"]
    description: "Talos Linux VM for Kubernetes cluster"
    image_file: "memini:import/talos-nocloud-1.11.1.qcow2"
    os_type: "l26"
    cores: 2
    ram: 2048
    disk_size: 10
```

Выполняем `terraform plan`, убеждаемся, что Terraform предлагает создать наши виртуальные машины, и применяем изменения командой `terraform apply`.

### Генерация конфигурации Talos

После создания первой мастер ноды нужно получить референсные конфигурации, чтобы не создавать их вручную:
```bash
export CONTROL_PLANE_IP=192.168.1.101
cd ~
talosctl gen config talos-proxmox-cluster https://$CONTROL_PLANE_IP:6443 --output-dir _out
```
Должно получиться:![Сгенерированные конфигурационные файлы Talos в директории _out](/blog/terraform-proxmox-talos/Pasted%20image%2020250920191633.png)

Можно поправить конфиги по желанию, можно оставить дефолт. В рамках первого кластера лучше оставить конфиги дефолтными и без понимания ничего не менять.

Следующим шагом нам надо создать модуль, который будет прокидывать эти конфиги в наши ВМ, создадим его `modules/talos_configs/talos_configs.tf`

```hcl
terraform {
  required_providers {
    proxmox = {
      source = "bpg/proxmox"
    }
  }
}

locals {
  enabled_configs = {
    for key, config in var.talos_configs.configs : key => config
    if config.enabled
  }
}

resource "proxmox_virtual_environment_file" "talos_configs" {
  for_each = local.enabled_configs

  # Use config-specific settings with fallback to global settings
  node_name    = coalesce(each.value.node_name, var.talos_configs.global.node_name)
  datastore_id = coalesce(each.value.datastore_id, var.talos_configs.global.datastore_id)

  content_type = each.value.content_type

  source_raw {
    data      = each.value.config_data
    file_name = each.value.file_name
  }
}
```
`variables.tf`
```hcl
variable "talos_configs" {
  description = "Configuration object containing Talos configs and global settings"
  type = object({
    global = object({
      node_name    = string
      datastore_id = string
    })
    configs = map(object({
      enabled      = bool
      content_type = string
      config_data  = string
      file_name    = string
      # Allow overriding global settings per config
      node_name    = optional(string)
      datastore_id = optional(string)
    }))
  })
}
```
и конфигурационный фалй в корне проекта `talos.tf`
```hcl
module "talos_configs" {
  source = "./modules/talos_configs"
  
  talos_configs = {
    global = {
      node_name    = "pve1"
      datastore_id = "memini"
    }
    configs = {
      "controlplane" = {
        enabled      = true
        content_type = "snippets"
        config_data  = file("~/_out/controlplane.yaml")
        file_name    = "talos-controlplane.yaml"
      }
      "worker" = {
        enabled      = true
        content_type = "snippets"
        config_data  = file("~/_out/worker.yaml")
        file_name    = "talos-worker.yaml"
      }
    }
  }
}
```
Делаем `terraform plan`, убеждаемся, что нам предлагает создать наши сниппеты и применяем `terraform apply`

### Конечная конфигурация ВМ

Нам нужно немного поправить модуль ВМ, чтобы он поддерживал user_data_file_id
Добавляем в раздел инициализации `modules/vms/vms.tf`:
`user_data_file_id = each.value.user_data_file_id`

в `variables.tf` в любое место мапы:
`
      user_data_file_id = optional(string)`

Все это можно подсмотреть в репозитории с кодом [тут](https://github.com/VizzleTF/proxmox_terraform/tree/main/tf%2Bproxmox%2Btalos) 

Дальше добавляем параметр к описанию ВМ и проверяем, талос поднимается через консоль:
```yaml
vms:
  talos-cp-01:
    node_name: "pve1"
    enabled: true
    vm_id: 401
    address: "192.168.1.101/24"
    tags: ["talos", "kubernetes"]
    description: "Talos Linux VM for Kubernetes cluster"
    image_file: "memini:import/talos-nocloud-1.11.1.qcow2"
    user_data_file_id: "memini:snippets/talos-controlplane.yaml"
    os_type: "l26"
    cores: 2
    ram: 2048
    disk_size: 10
  talos-cp-01:
    node_name: "pve3"
    enabled: true
    vm_id: 402
    address: "192.168.1.102/24"
    tags: ["talos", "kubernetes"]
    description: "Talos Linux VM for Kubernetes cluster"
    image_file: "memini:import/talos-nocloud-1.11.1.qcow2"
    user_data_file_id: "memini:snippets/talos-controlplane.yaml"
    os_type: "l26"
    cores: 2
    ram: 2048
    disk_size: 10
  talos-cp-01:
    node_name: "pve2"
    enabled: true
    vm_id: 403
    address: "192.168.1.103/24"
    tags: ["talos", "kubernetes"]
    description: "Talos Linux VM for Kubernetes cluster"
    image_file: "memini:import/talos-nocloud-1.11.1.qcow2"
    user_data_file_id: "memini:snippets/talos-controlplane.yaml"
    os_type: "l26"
    cores: 2
    ram: 2048
    disk_size: 10
```
## Инициализация кластера

### Bootstrap первой ноды

После того как виртуальные машины загрузятся, нужно выполнить следующие команды:
```bash
export CONTROL_PLANE_IP=192.168.1.101
talosctl config endpoint $CONTROL_PLANE_IP
talosctl config node $CONTROL_PLANE_IP
talosctl bootstrap
```
После bootstrap нода перезагрузится, и остальные ноды должны автоматически подключиться к кластеру.

### Проверка состояния кластера

После успешной инициализации можно проверить состояние кластера:
```bash
cd ~
talosctl kubeconfig talos.kube.conf
export KUBECONFIG=~/talos.kube.conf
kubectl get nodes
```
![Вывод kubectl get nodes — ноды Kubernetes кластера на Talos в статусе Ready](/blog/terraform-proxmox-talos/Pasted%20image%2020250920192949.png)

Точно также можно добавлять и воркеров в наши ноды, только указывая `user_data_file_id: "memini:snippets/talos-worker.yaml"`

```yaml
  talos-worker-01:
    node_name: "pve5"
    enabled: true
    vm_id: 404
    address: "10.11.12.204/24"
    tags: ["talos", "kubernetes"]
    description: "Talos Linux VM for Kubernetes cluster"
    image_file: "memini:import/talos-nocloud-1.11.1.qcow2"
    user_data_file_id: "memini:snippets/talos-worker.yaml"
    os_type: "l26"
    cores: 2
    ram: 2048
    disk_size: 10      
```

## Заключение

Мы успешно развернули Kubernetes кластер на базе Talos Linux в Proxmox с помощью Terraform. Этот подход обеспечивает:

- **Автоматизацию**: Полностью автоматизированное развертывание через Infrastructure as Code
- **Безопасность**: Talos Linux предоставляет минимальную и безопасную операционную систему
- **Масштабируемость**: Легкое добавление новых нод в кластер
- **Воспроизводимость**: Возможность быстро пересоздать кластер с идентичной конфигурацией

Теперь у вас есть готовый к работе Kubernetes кластер, который можно использовать для развертывания приложений и сервисов.
