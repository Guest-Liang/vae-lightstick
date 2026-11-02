## HansZ8 / EncoreLightSticks

- 项目：<https://github.com/HansZ8/EncoreLightSticks>
- 协议说明：<https://github.com/HansZ8/EncoreLightSticks/blob/main/docs/protocols/basic.md>
- 原始图像：<https://github.com/HansZ8/EncoreLightSticks/blob/main/docs/protocols/assets/manchester.png>

采用内容：Manchester 规则、旧七分区结构、校验关系与波形研究基础，原图说明指向 Soul Power II 2025 苏州站。
本项目从图片像素恢复周期和字节、核对相邻周期残段与三处校验、在本项目三支荧光棒上验证第八组字段。

>[!Note]
>### 以下内容由GPT-6.1-Sol Max生成
>在已有候选仍无法控制 8 号荧光棒后，我们重新检查了 [EncoreLightSticks 的协议文档](https://github.com/HansZ8/EncoreLightSticks/blob/main/docs/protocols/basic.md)。文档中的一张[波形图](https://github.com/HansZ8/EncoreLightSticks/blob/main/docs/protocols/assets/manchester.png)标注为“信号源自 Soul Power II 2025 苏州站，信号格式有所不同”，因此它可能包含旧七分区实现尚未解释的结构。
>当时检查的仓库文件中没有找到可直接分析或回放的原始抓包，于是我们改从未经缩放的原始 PNG 中恢复数据。
>
>具体分析从波形的竖直边沿开始：在图像中部扫描蓝色线条，将相邻像素归并为同一条边沿，再结合顶部、底部的电平轨道判断每一段是高电平还是低电平。边沿间距主要集中在约 **5.375 像素及其两倍**，据此将脉宽量化为 Manchester 半符号，并定位两个较长的同步低电平。
>
>按仓库说明的同步和起始位规则整理后，两个同步位置之间可以恢复出一个包含 **262 个半符号**的完整周期。扣除同步段的 4 个半符号后，剩余 258 个半符号；每两个半符号组成一个 Manchester 数据位，因此得到 129 位。再去掉一个起始位，剩下：
>```text
>128 bit ÷ 8 = 16 byte
>```
>恢复出的周期字节序列为：
>```text
>2F 2F 2F 2F 2F 2F 2F 7F 00 7F 80 03 8B 03 03 88
>```
>随后，我们枚举不同位置之前的数据前缀，套用旧协议已知的半字节 XOR 校验规则，发现三个位置都能匹配：
>| 字节位置，从 1 开始 | 图中恢复的值 | 符合校验关系的覆盖范围 |
>|---|---|---|
>| 第 11 字节 | `80` | 前 10 字节 |
>| 第 13 字节 | `8B` | 前 12 字节，包含第一个校验字节 |
>| 第 16 字节 | `88` | 前 15 字节，包含前两个校验字节 |
>
>这为一个新的结构假设提供了依据：**较长格式可能保留旧七分区数据及其校验，再在旧校验字节之后追加字段和新的校验。** 这与此前把第八个颜色放在旧校验之前的 14 字节候选不同。
>
>为了进一步检查恢复结果，我们还比较了图片两端相邻周期的残段：后一个周期开头的 5 位、前一个周期末尾的 12 个半符号，都与恢复出的重复序列吻合。将恢复字节按发送线序重新编码后，生成周期也与图中量化得到的全部 262 个半符号逐项一致。这些检查共同支持了帧边界和字节恢复结果。
>
>至此，离线分析得到了一份来源可核对、周期与校验关系自洽的候选帧。第 12 字节是否对应第八组、该格式是否能控制本次南宁站样机，仍需通过原样回放、修改字段和灯光观察确认。后续实物对照才验证了第八组的颜色位置；第 14、15 字节的用途则仍未完成映射。

## wuhan005 / LightStick

- 项目：<https://github.com/wuhan005/LightStick>
- 参考文件：<https://github.com/wuhan005/LightStick/blob/master/lightstick.py>

采用内容：七分区颜色打包、250 us Manchester 半位宽、末两字节先发的线序以及可工作的 500 us 同步参考。`led17.py` 的编码与游程合并逻辑由本地研究版本整理而来。

本项目将 RAW 正文长度从写死的 11 字节改为 `packet[:-2]`，使其支持完整扩展帧；增加第八组字段和三处校验；生成 FZ RAW 文件及自动关闭的 JS 脚本。保留旧七分区关闭帧作为关闭序列的一部分。