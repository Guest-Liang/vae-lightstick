/**
 * TypeScript port of research/led17.py. That module documents the upstream
 * color packing, nibble-XOR and Manchester references. The 16-byte layout,
 * RAW serialization and browser integration are additions from this project.
 */
export type Rgb = readonly [number, number, number]
export type GroupColors = readonly Rgb[]
export const OFF: Rgb = [0, 0, 0]

// Same Ook650 registers as Unleashed 094; PATABLE[1] is fixed to 0x07 below.
// TI DN013 Table 2: typical -25.3 dBm, labelled approximately -25 dBm / 0.0032 mW.
// See research/THIRD_PARTY_NOTICES.md for the firmware and datasheet sources.
const OOK650_REGISTERS =
  '02 0D 03 07 08 32 0B 06 14 00 13 00 12 30 11 32 10 17 ' +
  '18 18 19 18 1D 91 1C 00 1B 07 20 FB 22 11 21 B6 00 00'

function checksum(data: number[]): number {
  let value = 0xd
  for (const byte of data) value ^= (byte >> 4) ^ (byte & 0xf)
  return 0x80 | value
}

export function encodeColor([red, green, blue]: Rgb): number {
  return ((blue >> 6) << 6) | ((green >> 6) << 4) | ((red >> 6) << 2) | 3
}

export function buildPacket(colors: GroupColors): number[] {
  const data = colors.slice(0, 7).map(encodeColor)
  data.push(0, 0, 0, 0, encodeColor(colors[7]!), 0, 3, 3, 0)
  for (const position of [10, 12, 15])
    data[position] = checksum(data.slice(0, position))
  return data
}

export function buildLegacyOff(): number[] {
  const data = [3, 3, 3, 3, 3, 3, 3, 0, 0, 0]
  return [...data, checksum(data), 0, 0]
}

export function buildRaw(
  packet: number[],
  frames: number,
  legacy = false,
): string {
  const runs: number[] = []
  // Run merging and byte emission are reused for each Manchester half-bit.
  const append = (duration: number) => {
    const last = runs.length - 1
    if (last >= 0 && runs[last]! > 0 === duration > 0) runs[last]! += duration
    else runs.push(duration)
  }
  const appendBytes = (bytes: number[]) => {
    for (const byte of bytes) {
      for (let shift = 7; shift >= 0; shift--) {
        const bit = (byte >> shift) & 1
        append(bit ? -250 : 250)
        append(bit ? 250 : -250)
      }
    }
  }
  for (let frame = 0; frame < frames; frame++) {
    appendBytes(packet.slice(-2))
    append(legacy ? -500 : -1000)
    append(250)
    append(-250)
    appendBytes(packet.slice(0, -2))
    if (legacy) append(-50_000)
  }
  const lines = [
    'Filetype: Flipper SubGhz RAW File',
    'Version: 1',
    'Frequency: 433920000',
    'Preset: FuriHalSubGhzPresetCustom',
    'Custom_preset_module: CC1101',
    `Custom_preset_data: ${OOK650_REGISTERS} 00 07 00 00 00 00 00 00`,
    'Protocol: RAW',
  ]
  for (let index = 0; index < runs.length; index += 256) {
    lines.push(`RAW_Data: ${runs.slice(index, index + 256).join(' ')}`)
  }
  return `${lines.join('\n')}\n`
}

export function hexColor(color: Rgb): string {
  return `#${color.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

export function displayColor(color: Rgb): string {
  return hexColor([
    (color[0] >> 6) * 85,
    (color[1] >> 6) * 85,
    (color[2] >> 6) * 85,
  ])
}
