# FZ 原生灯光应用

常驻的 `VAE Lightstick` 应用，通过 FZ 现有 USB CLI 接收八组颜色，在内存中生成 LED17 波形，并使用内置 CC1101、定时器／DMA 异步发射。

本次构建面向 **Unleashed `unlshd-094e`／F7 API `88.19`**。网页包含配套二进制，连接时校验设备上的文件，按需安装后自动启动。无需重新刷固件，无需新增硬件。

## 使用

普通使用直接打开网页并连接 FZ。网页将应用保存在：

```text
/ext/apps/vae-lightstick/vae_lightstick.fap
```

也可以将 `dist/vae_lightstick.fap` 手动复制到该位置，再从 FZ 的文件浏览器运行。应用屏幕显示固定射频配置、已执行发送次数和上次发送耗时。FZ 的 **OK** 键发送全部关灯，**返回**键退出应用；返回键退出、网页断开连接都不额外发送关灯，请先关闭网页实时模式或发送“全部关灯”。

应用运行期间保持设备唤醒，退出后释放无线电及唤醒占用。不会改写自动关机设置。应用启动、信息查询、退出都不发射。

## 本地构建

需要 Python、[uFBT](https://github.com/flipperdevices/flipperzero-ufbt) 和匹配固件的 SDK。本次使用 uFBT **0.2.6**；SDK 固定使用当前已验证固件的版本。

在本目录运行：

```sh
python -m pip install ufbt==0.2.6
python -m ufbt update --hw-target f7 --url https://github.com/DarkFlippers/unleashed-firmware/releases/download/unlshd-094/flipper-z-f7-sdk-unlshd-094.zip
python -m ufbt
python package.py
```

uFBT 默认将工具链与 SDK 缓存放在用户目录；如需隔离构建，可按 uFBT 文档设置 `UFBT_HOME`。项目已忽略本目录的 `dist/`、`.ufbt/`、`.env` 和 `.vscode/`。

`package.py` 读取实际 FAP 的 ELF 元数据，提取 SDK API 版本、文件长度和 MD5，再将应用与清单更新到 `web/src/native/`。网页已包含这两个文件，静态站点构建只需运行 npm，不需要在部署服务器安装 C 工具链。修改 C 应用后，请重新编译并运行打包脚本，再构建网页。

本次 SDK 下载文件 SHA-256：

```text
50d78cb269c796dd3f25df68e5704db817783f855a466ea0399eeee4c2ae806f
```

## USB 命令

应用运行后注册 `vae` 命令。颜色参数由 **8 个颜色字节**拼接成 **16 位十六进制字符串**，顺序为 G1–G8。每个颜色字节仍采用 `BB GG RR 11`。例如 `0303030303030fc3` 表示 G1–G6 关闭、G7 红、G8 蓝。

| 命令 | 行为 |
| --- | --- |
| `vae info` | 返回协议版本、固定功率表值、载波与实时重复帧数，不发射 |
| `vae live <颜色>` | 从内存发送 3 帧完整格式 |
| `vae hold <颜色>` | 发送 32 帧，保持颜色 |
| `vae auto <颜色> <后续颜色>` | 发送 32 帧颜色，接着发送 16 帧后续颜色；网页用它只关闭已选组 |
| `vae off` | 发送 16 帧完整八组关闭，再发送 8 帧旧七组关闭 |
| `vae exit` | 退出应用，不额外发射 |

发送完成返回 `VAE:OK <设备耗时毫秒>`；输入或发射失败返回 `VAE:ERROR ...`。`OK` 只表示 FZ 完成发射，灯棒没有状态回传。

功率表在 C 常量中固定为 `00 07 00 00 00 00 00 00`，命令没有功率或频率参数。频率固定 `433920000 Hz`。含义及数值来源见主 README。

## 发送路径与性能

应用启动时配置一次射频。每次收到颜色后，在内存里构造 16 字节报文与 Manchester 游程，再调用 FZ 原生异步发射接口；发射完成切回空闲，保留配置供下次复用。不会在每次改色时写 SD 卡、启动 JS、加载通用协议密钥库，或另开 RAW 文件读取线程。波形使用 DMA 输出，完成等待以 1 ms 为间隔。

网页继续使用已有的最新配色队列，同一 USB 会话依次发送命令。快速滑动时只保留最新待发颜色；关闭实时模式先丢弃待发配色，等待当前发送结束后关灯。

2026-11-03，同一台 FZ、相同固定低功率、相同 3 帧格式的 USB CLI 测速：旧 JS／RAW 路径单次约 1560–1591 ms；原生路径连续 10 次平均约 **215.8 ms／4.63 次每秒**，其中设备发射流程约 **200 ms**。这些是发送流程耗时，不能证明每支灯棒都接收成功，也不是安卓手机端测速。3 帧空中时间本身约 196.5 ms，理想更新率上限约 5.09 次每秒。

## 文件与来源

| 文件 | 用途与来源 |
| --- | --- |
| `application.fam` | 本项目编写的 uFBT 外部应用清单 |
| `vae_lightstick.c` | 本项目编写的应用、CLI 输入解析、屏幕交互、内存波形与原生发射逻辑 |
| `package.py` | 本项目编写的构建产物打包工具，按官方 FAP 元数据格式读取 API 版本 |
| `../web/src/native/vae_lightstick.fap` | 本目录 C 源码编译出的网页配套应用 |
| `../web/src/native/manifest.ts` | `package.py` 生成的配套文件信息 |

`vae_checksum`、`vae_bytes`、`vae_frame` 将本项目 `research/led17.py` 与 `web/src/protocol.ts` 中的规则移植为 C。

射频寄存器配置沿用项目已有的 Unleashed Ook650 配置与 TI `07` 功率条目；原生应用结构、CLI 协议、内存缓存和网页接入为本项目新增。没有将上游灯棒控制程序或固件 C 文件整段复制到本应用。调用的是固件提供的 API，参考资料：

- [原生 Sub-GHz 异步发射接口](https://developer.flipper.net/flipperzero/doxygen/furi__hal__subghz_8h.html)
- [当前固件的 CLI 注册接口](https://github.com/DarkFlippers/unleashed-firmware/blob/2f62b3ab5d767c41e09ab17c6b5fbd175c8c4c85/lib/toolbox/cli/cli_registry.h)
- [当前固件的 FAP 元数据定义](https://github.com/DarkFlippers/unleashed-firmware/blob/2f62b3ab5d767c41e09ab17c6b5fbd175c8c4c85/scripts/fbt/elfmanifest.py)
