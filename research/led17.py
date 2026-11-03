"""LED17 packet construction and Manchester RAW encoding; no device I/O.

This is a mixed-origin module. Function docstrings identify the legacy code
references and this project's additions; see THIRD_PARTY_NOTICES.md for the full map.
"""

from pathlib import Path


Color = tuple[int, int, int]
COLORS: dict[str, Color] = {
    "off": (0, 0, 0),
    "red": (255, 0, 0),
    "green": (0, 255, 0),
    "blue": (0, 0, 255),
}
FREQUENCY_HZ = 433_920_000
# Keep the working Unleashed 094 Ook650 registers; PATABLE[1] is fixed to 0x07.
# TI DN013 Table 2 gives typical -25.3 dBm, labelled approximately -25 dBm / 0.0032 mW.
# Sources and the distinction from the lightstick protocol are in THIRD_PARTY_NOTICES.md.
OOK650_REGISTERS = (
    "02 0D 03 07 08 32 0B 06 14 00 13 00 12 30 11 32 10 17 "
    "18 18 19 18 1D 91 1C 00 1B 07 20 FB 22 11 21 B6 00 00"
)


def checksum(data: bytes | list[int]) -> int:
    """Reimplement the upstream nibble-XOR formula for arbitrary prefix lengths.

    Formula: EncoreLightSticks/software/light_ctrl.py;
    reference implementation: wuhan005.calculate_checksum.
    This implementation also returns the fixed high nibble, unlike that reference.
    """
    value = 0xD
    for byte in data:
        value ^= (byte >> 4) ^ (byte & 0xF)
    return 0x80 | value


def encode_color(color: Color) -> int:
    """Simplify wuhan005.encode_zone_color; RGB channels must be in 0..255."""
    red, green, blue = (channel // 64 for channel in color)
    return (blue << 6) | (green << 4) | (red << 2) | 3


def build_legacy_packet(colors: list[Color]) -> bytes:
    """Simplify wuhan005.build_packet for its documented seven-group layout."""
    if len(colors) != 7:
        raise ValueError("exactly seven group colors are required")
    data = [encode_color(color) for color in colors] + [0, 0, 0]
    return bytes(data + [checksum(data), 0, 0])


def build_extended_packet(colors: list[Color]) -> bytes:
    """
    New here: build the 16-byte layout recovered and checked in this project.
    Reuse encode_color/checksum for the known packing and formula. The appended
    field positions and prefix lengths (10, 12, 15) come from this investigation.
    """
    if len(colors) != 8:
        raise ValueError("exactly eight group colors are required")
    data = [encode_color(color) for color in colors[:7]]
    # Index 11 is the verified group-8 colour. Indices 13/14 stay at 03;
    # their meaning has not been mapped on physical receivers.
    data += [0, 0, 0, 0, encode_color(colors[7]), 0, 3, 3, 0]
    for position in (10, 12, 15):
        data[position] = checksum(data[:position])
    return bytes(data)


def append_run(runs: list[int], level: int, duration_us: int) -> None:
    """Adapt wuhan005.append_run from LevelRun objects to signed FZ timings."""
    value = duration_us if level else -duration_us
    if runs and (runs[-1] > 0) == (value > 0):
        runs[-1] += value
    else:
        runs.append(value)


def append_bytes(runs: list[int], data: bytes, half_bit_us: int) -> None:
    """Combine the reference append_manchester_bytes/bit encoding steps."""
    for byte in data:
        for shift in range(7, -1, -1):
            bit = (byte >> shift) & 1
            append_run(runs, 1 - bit, half_bit_us)
            append_run(runs, bit, half_bit_us)


def build_runs(
    packet: bytes,
    frame_count: int,
    sync_low_us: int = 1000,
    half_bit_us: int = 250,
    interframe_gap_us: int = 0,
) -> list[int]:
    """Follow wuhan005.build_frame_runs wire order, with repetition added here.
    Variable packet length and configurable timing are local extensions. The
    reference's fixed 11-byte body is correct for its intended 13-byte packets.
    """
    runs: list[int] = []
    for _ in range(frame_count):
        append_bytes(runs, packet[-2:], half_bit_us)
        append_run(runs, 0, sync_low_us)
        append_run(runs, 1, half_bit_us)
        append_run(runs, 0, half_bit_us)
        append_bytes(runs, packet[:-2], half_bit_us)
        if interframe_gap_us:
            append_run(runs, 0, interframe_gap_us)
    return runs


def write_signal(target: Path, packet: bytes, **timing: int) -> dict:
    """New here: serialize generated timings using Flipper's RAW file format."""
    runs = build_runs(packet, **timing)
    target.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "Filetype: Flipper SubGhz RAW File", "Version: 1",
        f"Frequency: {FREQUENCY_HZ}", "Preset: FuriHalSubGhzPresetCustom",
        "Custom_preset_module: CC1101",
        f"Custom_preset_data: {OOK650_REGISTERS} 00 07 00 00 00 00 00 00",
        "Protocol: RAW",
    ]
    lines.extend(
        "RAW_Data: " + " ".join(map(str, runs[i:i + 256]))
        for i in range(0, len(runs), 256)
    )
    target.write_text("\n".join(lines) + "\n", encoding="ascii")
    return {"packet_hex": packet.hex(" ").upper(), "duration_us": sum(map(abs, runs))}
