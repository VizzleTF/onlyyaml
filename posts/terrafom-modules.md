---
title: Создание модулей Terraform
summary: Гайд по созданию модулей terraform на примере proxmox провайдера bpg
date: Sep 20 2025
tags:
  - terraform
  - proxmox
  - infrastructure as code
rss: >-
  Terraform - продолжение. Создание модулей terraform на примере proxmox
  провайдера bpg
seoTitle: 'Terraform модули: Создание переиспользуемых компонентов'
seoDescription: >-
  Пошаговое руководство по созданию Terraform модулей. Разработка модуля для
  cloud-образов в Proxmox, структура проекта, переменные и outputs.
category: gitops
---

В [предыдущей статье](/blog/terraform-proxmox/) (Terraform + Proxmox) мы переиспользовали готовый модуль для создания виртуальных машин.
В этой статье создадим собственный модуль для автоматического скачивания cloud-образов операционных систем.

## Cloud-images vs Дистрибутив

### Что такое cloud-образ и чем он отличается от обычного образа?

**Обычный образ** — это ISO-файл с дистрибутивом для установки ОС. При развёртывании на его основе обычно требуется ручная или скриптовая установка и настройка системы.

**Cloud-образ** — это виртуальный диск, содержащий уже установленную и настроенную операционную систему, снабжённый механизмами автоматической инициализации (в нашем случае через _cloud-init_). При старте виртуальной машины облачная платформа или гипервизор передаёт этим механизмам параметры (имя хоста, SSH-ключи, сетевые настройки и др.), после чего система автоматически завершает настройку без вмешательства пользователя.

|Свойство|Cloud-образ|Обычный образ|
|---|---|---|
|Настройка при первом запуске|Автоматическая через cloud-init|Отсутствует, требует ручной или скриптовой настройки|
|Размер|Оптимизирован, содержит только базовые компоненты|Может быть больше, включает полный дистрибутив или ПО|
|Интеграция с платформой|Тесно интегрирован с облачными сервисами (метаданные, сети, SSH-ключи)|Независим от платформы, без автоматической интеграции|
|Масштабируемость|Высокая: быстрый клонинг и развертывание множества экземпляров с разными параметрами|Средняя: требуется дополнительная настройка для каждого клона|
|Сценарии использования|Автоматизация CI/CD, быстрый автоскейлинг, унифицированные VM|Кастомные шаблоны, специализированные инсталляции, физические серверы|

## Изучение ресурса

Создание любого модуля начинается с изучения ресурса, который мы хотим описать. В нашем случае это [proxmox_virtual_environment_download_file](https://registry.terraform.io/providers/bpg/proxmox/latest/docs/resources/virtual_environment_download_file).

Ознакомившись с примерами и схемой, разберём основные поля:

```hcl
resource "proxmox_virtual_environment_download_file" "release_20231228_debian_12_bookworm_qcow2" {
  content_type       = "import"
  datastore_id       = "local"
  file_name          = "debian-12-generic-amd64-20231228-1609.qcow2"
  node_name          = "pve"
  url                = "https://cloud.debian.org/images/cloud/bookworm/20231228-1609/debian-12-generic-amd64-20231228-1609.qcow2"
  checksum           = "d2fbcf11fb28795842e91364d8c7b69f1870db09ff299eb94e4fbbfa510eb78d141e74c1f4bf6dfa0b7e33d0c3b66e6751886feadb4e9916f778bab1776bdf1b"
  checksum_algorithm = "sha512"
}

resource "proxmox_virtual_environment_download_file" "latest_debian_12_bookworm_qcow2_img" {
  content_type = "iso"
  datastore_id = "local"
  file_name    = "debian-12-generic-amd64.qcow2.img"
  node_name    = "pve"
  url          = "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2"
}
```

Основные параметры, которые нас интересуют в первую очередь:

| Параметр     | Тип    | Описание                                                                              | Пример значения                                                                          |
| ------------ | ------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| content_type | String | Тип содержимого образа, определяет папку на датасторе (например, `iso` или `vztmpl`). | iso                                                                                      |
| datastore_id | String | Идентификатор datastore, куда будет сохранён образ.                                   | local-lvm                                                                                |
| node_name    | String | Имя узла (node) Proxmox, с которого будет выполняться загрузка образа.                | pve01                                                                                    |
| url          | String | URL для скачивания образа.                                                            | [https://example.com/ubuntu-22.04-cloud.img](https://example.com/ubuntu-22.04-cloud.img) |

Дополнительные параметры, которые могут быть полезны:

| Параметр                | Тип     | Описание                                                                                                                                                    |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| checksum                | String  | Ожидаемая контрольная сумма файла.                                                                                                                          |
| checksum_algorithm      | String  | Алгоритм расчёта контрольной суммы. Допустимые: `md5`, `sha1`, `sha224`, `sha256`, `sha384`, `sha512`.                                                      |
| decompression_algorithm | String  | Алгоритм распаковки после загрузки. Допустимые: `gz`, `lzo`, `zst`, `bz2`.                                                                                  |
| file_name               | String  | Имя файла в datastore. По умолчанию вычисляется из URL.                                                                                                     |
| overwrite               | Boolean | Если `true` (по умолчанию), при изменении размера файла в datastore он будет перезаписан. Если `false`, проверка не будет выполняться.                      |
| overwrite_unmanaged     | Boolean | Если `true`, при наличии файла с тем же именем в datastore старый файл удаляется и загружается новый. Если `false`, в случае существования выдается ошибка. |
| upload_timeout          | Number  | Таймаут на загрузку файла в секундах. По умолчанию 600 (10 мин).                                                                                            |
| verify                  | Boolean | Если `true` (по умолчанию), проверяются SSL/TLS сертификаты при скачивании. Если `false`, проверка отключается.                                             |

Для нашего модуля, помимо основных, будем использовать следующие параметры (сделаем их необязательными):

`checksum`, `checksum_algorithm`, `file_name`, `overwrite`, `upload_timeout`

## Создание модуля

### Конфигурационный файл

Создадим конфигурационный файл `cloud_images.tf` в корне проекта, который будет парсить наш YAML-конфиг в модуль:
```hcl
locals {
  images_config = yamldecode(file("./configs/images.yaml"))
}

module "cloud_images" {
  source = "./modules/cloud_images"

  images_config = local.images_config
}
```

### Модуль

Создадим папку для нашего нового модуля и два файла в ней:
![Структура папки модуля cloud_images с файлами images.tf и variables.tf](/blog/terrafom-modules/Pasted%20image%2020250920113032.png)

Начнём заполнять наш модуль `images.tf`:

Описываем провайдер, который будет использоваться модулем:
```hcl
terraform {
  required_providers {
    proxmox = {
      source = "bpg/proxmox"
    }
  }
}
```

Поскольку мы будем использовать булевый параметр `enable`, соберём новую карту (map) только с включёнными образами:
```hcl
locals {
  enabled_images = {
    for key, image in var.images_config.images : key => image
    if image.enabled
  }
}
```

Создаём ресурс:

```hcl
resource "proxmox_virtual_environment_download_file" "cloud_images" {
  for_each = local.enabled_images

  content_type = "iso"
  datastore_id = each.value.datastore_id
  node_name    = each.value.node_name
  url          = each.value.url
  file_name    = each.value.file_name

  checksum            = try(each.value.checksum, null)
  checksum_algorithm  = try(each.value.checksum_algorithm, null)
  compression         = try(each.value.compression, null)
  decompression_algorithm = try(each.value.decompression_algorithm, null)
  overwrite           = try(each.value.overwrite, null)
  overwrite_unmanaged = try(each.value.overwrite_unmanaged, null)
}
```
for_each - оператор цикла, который пройдет по списку образов, которые мы пометили для скачивания.
coalesce -  встроенная функция для работы с несколькими значениями, которая возвращает первый аргумент, не равный `null`. Если все аргументы равны `null`, функция возвращает `null`. 
### Переменные

Теперь создадим файл `variables.tf` для описания входных переменных модуля:

Заполним файл переменных для модуля, согласно документации и выбранных нами переменных:
```hcl
variable "images_config" {
  description = "Configuration object containing images and global settings from YAML file"
  type = object({
    global = object({
      node_name      = string
      datastore_id   = string
      upload_timeout = optional(number, 3600)
      overwrite      = optional(bool, false)
    })
    images = map(object({
      enabled            = bool
      content_type       = string
      url                = string
      file_name          = optional(string)
      checksum           = optional(string)
      checksum_algorithm = optional(string)
      node_name          = optional(string)
      datastore_id       = optional(string)
      upload_timeout     = optional(number)
      overwrite          = optional(bool)
    }))
  })
}
```
### Инвентарный файл с образами

Создадим файл с образами, которые хотим скачать![Структура папки configs с файлом images.yaml](/blog/terrafom-modules/Pasted%20image%2020250920114914.png)

И заполним его сперва global переменными, а потом образ-специфичными:
```yaml
global:
  node_name: "pve1"
  datastore_id: "local"
  upload_timeout: 3600
  overwrite: false

images:
  ubuntu_22_04:
    enabled: true
    content_type: "import"
    url: "https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img"
    file_name: "ubuntu-22.04-cloudimg-amd64.img"
    checksum: "sha256:b2175cd98cfb13f0b5493e8c8b0e6d6c8b2e6b6b6b6b6b6b6b6b6b6b6b6b6b6b"
   checksum_algorithm: "sha256"
   # Override global settings for this image
   node_name: "pve2" # Use different node
   upload_timeout: 7200 # Longer timeout for this image
 
  debian_12:
    enabled: true
    content_type: "import"
    url: "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2"
    file_name: "debian-12-generic-amd64.qcow2"
    checksum: "sha256:d2fbcf11fb28795842e91364d8c7b69f1870db09ff299eb94e4fbbfa510eb78d"
    checksum_algorithm: "sha256"
    # Use different datastore for this image
    datastore_id: "fast-ssd"
    
  rocky_linux_9:
    enabled: false
    content_type: "import"
    url: "https://download.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud-Base.latest.x86_64.qcow2"
```
### Output (для наглядности)

Output - это блок, который позволяет экспортировать значения из модуля или корневой конфигурации и делать их доступными. В нашем случае мы его используем только для того, чтобы посмотреть, какие образа будут у нас скачиваться:

Создадим файл output.tf в папке модуля:
![Структура папки модуля с добавленным файлом output.tf](/blog/terrafom-modules/Pasted%20image%2020250920115838.png)
со следующим содержимым:
```hcl
output "downloaded_image_files" {
  description = "List of downloaded image file names"
  value = [
    for key, image in proxmox_virtual_environment_download_file.cloud_images : image.file_name
  ]
}
```
теперь создадим конфигурационный файл в корне output.tf, который будет вызывать этот аутпут:
```hcl
output "downloaded_image_files" {
  description = "List of downloaded image file names"
  value       = module.cloud_images.downloaded_image_files
}
```

Важное замечание, мы не можем использовать аутпут параметры модуля, которые не заведены в самом модуле, т.е. получить больше, чем указали в первом файле.

Вывод команды terraform plan:
![Результат выполнения terraform plan - создание двух ресурсов](/blog/terrafom-modules/Pasted%20image%2020250920120055.png)

Как мы можем видеть, тф создаст нам 2 ресурса, как мы и указали в конфиге.

Если мы попробуем активировать наш 3 образ, в котором не определяем название
![Активация третьего образа в конфигурации](/blog/terrafom-modules/Pasted%20image%2020250920120240.png)
то получим следующее:
![Результат terraform plan с тремя ресурсами](/blog/terrafom-modules/Pasted%20image%2020250920120253.png)
Потому что имя тф "достанет" только после создания ресурса. 

## Заключение

Мы создали Terraform-модуль для автоматизации загрузки cloud-образов в Proxmox. Модуль позволяет:

- Управлять множественными образами через YAML-конфигурацию
- Включать/отключать образы с помощью флага `enable`
- Использовать как обязательные, так и опциональные параметры
- Легко масштабировать и поддерживать инфраструктуру

Такой подход делает управление образами более структурированным и позволяет легко добавлять новые образы без изменения основного кода.

Все примеры, лежат в этом [репозитории](https://github.com/VizzleTF/proxmox_terraform/tree/main/tf%2Bproxmox_advanced).
