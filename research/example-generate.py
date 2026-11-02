"""本项目编写的 FZ 信号与 JS 生成器；协议编码由同目录 led17.py 提供。

只生成本地文件。颜色脚本发送约两秒后追加扩展和旧版关闭帧。
"""

import argparse
from pathlib import Path

from led17 import COLORS, build_extended_packet, build_legacy_packet, write_signal


DEVICE_SIGNALS = "/ext/subghz/LED17_7_8/"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out-dir", type=Path,
        default=Path(__file__).resolve().parent / "output",
        help="输出目录，默认是脚本同目录的 output",
    )
    args = parser.parse_args()
    out = args.out_dir.resolve()
    signals = out / "subghz" / "LED17_7_8"
    scripts = out / "apps" / "Scripts" / "LED17_7_8"
    scripts.mkdir(parents=True, exist_ok=True)
    off, red, green, blue = (COLORS[name] for name in ("off", "red", "green", "blue"))
    patterns = {
        "all_off": (off, off),
        "both_red": (red, red),
        "both_green": (green, green),
        "both_blue": (blue, blue),
        "group7_red_group8_blue": (red, blue),
        "group7_blue_group8_red": (blue, red),
        "group7_red": (red, off),
        "group8_red": (off, red),
        "group8_green": (off, green),
        "group8_blue": (off, blue),
    }
    write_signal(
        signals / "legacy_off.sub", build_legacy_packet([off] * 7),
        frame_count=8, sync_low_us=500, half_bit_us=250, interframe_gap_us=50000,
    )
    for name, (color7, color8) in patterns.items():
        packet = build_extended_packet([off] * 6 + [color7, color8])
        details = write_signal(
            signals / (name + ".sub"), packet,
            frame_count=16 if name == "all_off" else 32,
            sync_low_us=1000, half_bit_us=250, interframe_gap_us=0,
        )
        lines = ['let subghz = require("subghz");', 'subghz.setup();']
        if name != "all_off":
            lines.extend([
                'print("' + name + ': about 2 seconds, then automatic OFF");',
                'print(subghz.transmitFile("' + DEVICE_SIGNALS + name + '.sub", 1));',
            ])
        lines.extend([
            'print("Extended-frame OFF");',
            'print(subghz.transmitFile("' + DEVICE_SIGNALS + 'all_off.sub", 1));',
            'print("Legacy-frame OFF");',
            'print(subghz.transmitFile("' + DEVICE_SIGNALS + 'legacy_off.sub", 1));',
            'subghz.end();', '',
        ])
        (scripts / (name + ".js")).write_text("\n".join(lines), encoding="ascii")
        print(f"{name}: {details['packet_hex']} ({details['duration_us'] / 1e6:.3f}s)")
    print(f"已生成 11 个信号文件和 10 个 JS 脚本：{out}")
    print("将 subghz 和 apps 下的对应目录复制到 FZ 的 microSD 卡。")


if __name__ == "__main__":
    main()
