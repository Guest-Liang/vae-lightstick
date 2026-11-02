import { OFF, buildLegacyOff, buildPacket, buildRaw } from './protocol'
import type { GroupColors } from './protocol'

const DIRECTORY = '/ext/subghz/vae-lightstick-web'
const PROMPT = '>: '
type Progress = (message: string) => void

/** Browser-side CLI client written here; no firmware or Python CLI code copied. */
export class FlipperSerial {
  private port?: SerialPort
  private reader?: ReadableStreamDefaultReader<Uint8Array>
  private writer?: WritableStreamDefaultWriter<Uint8Array>
  private buffer = ''
  private decoder = new TextDecoder()
  private encoder = new TextEncoder()

  constructor(private onDisconnect: () => void) { }

  async connect(
    progress: Progress,
  ): Promise<{ name: string; firmware: string }> {
    this.port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: 0x0483, usbProductId: 0x5740 }],
    })
    progress('正在打开 USB 串口…')
    await this.port.open({ baudRate: 115200 })
    await this.port.setSignals({ dataTerminalReady: true })
    if (!this.port.readable || !this.port.writable)
      throw new Error('USB 串口不可读写。')
    this.reader = this.port.readable.getReader()
    this.writer = this.port.writable.getWriter()
    this.port.addEventListener('disconnect', this.onDisconnect)
    await this.until(PROMPT)
    progress('正在确认 Flipper 响应…')
    const info = await this.command('device_info')
    if (!info.includes('hardware_model'))
      throw new Error('未收到 Flipper 的有效握手回复。')
    await this.command('storage stat "/ext"')
    await this.command(`storage mkdir "${DIRECTORY}"`, 'file/dir already exist')

    progress('正在准备灯光控制文件…')
    await this.writeFile(
      'off.sub',
      buildRaw(buildPacket(Array(8).fill(OFF)), 16),
    )
    await this.writeFile('legacy-off.sub', buildRaw(buildLegacyOff(), 8, true))
    // Probe only loads the module. Connecting never transmits radio signals.
    await this.writeFile(
      'probe.js',
      'let radio = require("subghz");\nprint("VAE:READY");\n',
    )
    for (const mode of ['auto', 'hold', 'off']) {
      const transmissions =
        mode === 'off'
          ? ['off.sub', 'legacy-off.sub']
          : mode === 'auto'
            ? ['color.sub', 'after.sub']
            : ['color.sub']
      const script = [
        'let radio = require("subghz");',
        'radio.setup();',
        ...transmissions.map(
          (file, index) =>
            `let ok${index} = radio.transmitFile("${DIRECTORY}/${file}", 1);`,
        ),
        'radio.end();',
        `print(${transmissions.map((_, index) => `ok${index}`).join(' && ')} ? "VAE:OK" : "VAE:FAILED");`,
        '',
      ].join('\n')
      await this.writeFile(`${mode}.js`, script)
    }
    const probe = await this.command(
      `js ${DIRECTORY}/probe.js`,
      undefined,
      20_000,
    )
    if (
      !probe.includes('VAE:READY') ||
      !probe.includes('Script done!') ||
      probe.includes('---- ERROR ----')
    ) {
      throw new Error(
        'FZ 未能运行 subghz JavaScript 模块，请确认固件支持该模块，并退出设备上的其他应用。',
      )
    }
    return {
      name:
        info.match(/hardware_name\s*:\s*([^\r\n]+)/)?.[1]?.trim() ||
        'Flipper Zero',
      firmware:
        info.match(/firmware_version\s*:\s*([^\r\n]+)/)?.[1]?.trim() || '',
    }
  }

  async send(
    colors: GroupColors,
    after: GroupColors | null,
    progress: Progress,
  ): Promise<void> {
    progress('正在确认设备响应…')
    await this.command('device_info')
    progress('正在写入本次颜色…')
    await this.writeFile('color.sub', buildRaw(buildPacket(colors), 32))
    if (after)
      await this.writeFile('after.sub', buildRaw(buildPacket(after), 16))
    progress(after ? '正在发送颜色，随后自动关灯…' : '正在发送颜色…')
    await this.runScript(after ? 'auto' : 'hold')
  }

  async off(progress: Progress): Promise<void> {
    progress('正在发送全部关灯指令…')
    await this.runScript('off')
  }

  async close(): Promise<void> {
    this.port?.removeEventListener('disconnect', this.onDisconnect)
    // A removed USB device can already have errored streams; release their locks.
    if (this.reader) {
      await this.reader.cancel().catch(() => undefined)
      this.reader.releaseLock()
    }
    this.writer?.releaseLock()
    if (this.port) await this.port.close().catch(() => undefined)
    this.reader = undefined
    this.writer = undefined
    this.port = undefined
    this.buffer = ''
  }

  private async runScript(mode: string): Promise<void> {
    const response = await this.command(
      `js ${DIRECTORY}/${mode}.js`,
      undefined,
      30_000,
    )
    if (
      !response.includes('VAE:OK') ||
      !response.includes('Script done!') ||
      response.includes('---- ERROR ----')
    ) {
      throw new Error(
        'FZ 没有确认发送成功。请检查设备屏幕、SD 卡和 subghz 模块后重新连接。',
      )
    }
  }

  private async command(
    command: string,
    allowedError?: string,
    timeout = 10_000,
  ): Promise<string> {
    await this.writer!.write(this.encoder.encode(`${command}\r`))
    const response = await this.until(PROMPT, timeout)
    const error = response.match(/Storage error:\s*([^\r\n]+)/)?.[1]?.trim()
    if (error && error !== allowedError)
      throw new Error(`FZ 存储错误：${error}`)
    if (/Command not found|Unknown command|command not found/i.test(response)) {
      throw new Error(
        'FZ 不支持所需的 CLI 命令，请确认当前固件带有 JavaScript 支持。',
      )
    }
    return response
  }

  private async writeFile(name: string, text: string): Promise<void> {
    const path = `${DIRECTORY}/${name}`
    await this.command(`storage remove "${path}"`, 'file/dir not exist')
    const bytes = this.encoder.encode(text)
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      const chunk = bytes.slice(offset, offset + 8192)
      await this.writer!.write(
        this.encoder.encode(`storage write_chunk "${path}" ${chunk.length}\r`),
      )
      await this.until('\r\n') // CLI command echo
      const ready = await this.until('\r\n')
      if (ready.trim() !== 'Ready')
        throw new Error(`FZ 未准备好接收文件：${ready.trim()}`)
      await this.writer!.write(chunk)
      const response = await this.until(PROMPT, 20_000)
      if (response.includes('Storage error:'))
        throw new Error(`FZ 写入文件失败：${response.trim()}`)
    }
  }

  private async until(marker: string, timeout = 10_000): Promise<string> {
    const reader = this.reader!
    let timedOut = false
    const timer = window.setTimeout(() => {
      timedOut = true
      void reader.cancel().catch(() => undefined)
    }, timeout)
    try {
      while (true) {
        const index = this.buffer.indexOf(marker)
        if (index >= 0) {
          const result = this.buffer.slice(0, index)
          this.buffer = this.buffer.slice(index + marker.length)
          return result.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        }
        const { value, done } = await reader.read()
        if (done)
          throw new Error(
            timedOut
              ? 'FZ 回复超时。请确认设备已开机、停在主界面，且 qFlipper 或其他网页没有占用串口。'
              : 'USB 连接已断开，请检查数据线并重新连接。',
          )
        this.buffer += this.decoder.decode(value, { stream: true })
      }
    } finally {
      window.clearTimeout(timer)
    }
  }
}
