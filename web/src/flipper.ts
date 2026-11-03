import { encodeColor } from './protocol'
import type { GroupColors } from './protocol'
import { UsbCdcPort } from './usb'
import nativeApplicationUrl from './native/vae_lightstick.fap?url'
import { nativeApplication } from './native/manifest'

export type ConnectionMethod = 'serial' | 'usb'

const DIRECTORY = '/ext/apps/vae-lightstick'
const APP_PATH = `${DIRECTORY}/vae_lightstick.fap`
const PROMPT = '>: '
type Progress = (message: string) => void

function colorArgument(colors: GroupColors): string {
  return colors.map(encodeColor).map(color => color.toString(16).padStart(2, '0')).join('')
}

/** Browser-side CLI client written here; no firmware or Python CLI code copied. */
export class FlipperSerial {
  private port?: SerialPort | UsbCdcPort
  private reader?: ReadableStreamDefaultReader<Uint8Array>
  private writer?: WritableStreamDefaultWriter<Uint8Array>
  private buffer = ''
  private decoder = new TextDecoder()
  private encoder = new TextEncoder()
  private nativeReady = false

  constructor(private onDisconnect: () => void) { }

  async connect(
    progress: Progress,
    method: ConnectionMethod = 'serial',
  ): Promise<{ name: string; firmware: string }> {
    if (method === 'usb') {
      const device = await navigator.usb.requestDevice({
        filters: [{ vendorId: 0x0483, productId: 0x5740 }],
      })
      this.port = new UsbCdcPort(device)
      progress(`已找到 ${device.productName || 'Flipper Zero'}，正在打开 USB 数据接口…`)
    } else {
      this.port = await navigator.serial.requestPort({
        filters: [{ usbVendorId: 0x0483, usbProductId: 0x5740 }],
      })
      progress('正在打开 USB 串口…')
    }
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
    if (!/hardware_model\s*:\s*Flipper Zero\s*(?:\r?\n|$)/.test(info))
      throw new Error('未收到 Flipper 的有效握手回复。')
    await this.command('storage stat "/ext"')
    let loader = await this.command('loader info')
    if (loader.includes('Application "VAE Lightstick" is running')) {
      await this.command('vae exit')
      for (let attempt = 0; attempt < 30; attempt++) {
        loader = await this.command('loader info')
        if (loader.includes('No application is running')) break
        await new Promise(resolve => window.setTimeout(resolve, 50))
      }
    }
    if (!loader.includes('No application is running'))
      throw new Error('请先退出 FZ 上正在运行的其他应用，再连接灯光控制台。')

    progress('正在检查配套的原生应用…')
    const metadata = nativeApplication
    await this.command(`storage mkdir "${DIRECTORY}"`, 'file/dir already exist')
    const hash = await this.command(`storage md5 "${APP_PATH}"`, 'file/dir not exist')
    if (hash.match(/\b[0-9a-f]{32}\b/i)?.[0]?.toLowerCase() !== metadata.md5) {
      progress('正在安装配套的 FZ 原生应用…')
      const binaryResponse = await fetch(nativeApplicationUrl)
      if (!binaryResponse.ok) throw new Error('网页缺少原生应用文件，请重新部署完整构建。')
      const bytes = new Uint8Array(await binaryResponse.arrayBuffer())
      if (bytes.length !== metadata.size) throw new Error('下载的原生应用文件不完整。')
      await this.writeFile(APP_PATH, bytes)
      const installed = await this.command(`storage md5 "${APP_PATH}"`)
      if (!installed.includes(metadata.md5)) throw new Error('FZ 上的原生应用文件校验失败，请重新连接。')
    }
    progress('正在启动原生发射应用…')
    const launch = await this.command(`loader open "${APP_PATH}"`)
    for (let attempt = 0; attempt < 30; attempt++) {
      const ready = await this.command('vae info', 'command not found')
      if (ready.includes(`VAE:NATIVE ${metadata.protocol} PA=07 FREQ=433920000 LIVE=3`)) {
        this.nativeReady = true
        break
      }
      await new Promise(resolve => window.setTimeout(resolve, 50))
    }
    if (!this.nativeReady)
      throw new Error(`FZ 原生应用未就绪，需要兼容 API ${metadata.api} 的固件。请检查设备屏幕。${launch.trim()}`)
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
    progress(after ? '正在发送颜色，随后自动关灯…' : '正在发送颜色…')
    await this.nativeCommand(after
      ? `auto ${colorArgument(colors)} ${colorArgument(after)}`
      : `hold ${colorArgument(colors)}`)
  }

  async off(progress: Progress): Promise<void> {
    progress('正在发送全部关灯指令…')
    await this.nativeCommand('off')
  }

  async sendLive(colors: GroupColors): Promise<number> {
    const started = performance.now()
    await this.nativeCommand(`live ${colorArgument(colors)}`)
    return Math.round(performance.now() - started)
  }

  async close(): Promise<void> {
    this.port?.removeEventListener('disconnect', this.onDisconnect)
    if (this.nativeReady) {
      this.nativeReady = false
      await this.command('vae exit').catch(() => undefined)
    }
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

  private async nativeCommand(command: string): Promise<void> {
    const response = await this.command(`vae ${command}`, undefined, 12_000)
    if (!/VAE:OK \d+/.test(response))
      throw new Error(response.match(/VAE:ERROR[^\r\n]*/)?.[0] ||
        'FZ 原生应用未确认发送完成。请检查设备屏幕后重新连接。')
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
    if (/Command not found|Unknown command|command not found/i.test(response) && allowedError !== 'command not found') {
      throw new Error(
        'FZ 不支持所需的 CLI 命令，或原生应用已退出，请重新连接。',
      )
    }
    return response
  }

  private async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    await this.command(`storage remove "${path}"`, 'file/dir not exist')
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
