/** WebUSB access to Flipper's first CDC-ACM interface; implemented here. */
export class UsbCdcPort extends EventTarget {
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null
  private controlInterface = 0

  constructor(private device: USBDevice) {
    super()
  }

  private handleDisconnect = (event: USBConnectionEvent) => {
    if (event.device === this.device) this.dispatchEvent(new Event('disconnect'))
  }

  async open(options: SerialOptions): Promise<void> {
    await this.device.open()
    const configuration = this.device.configurations.find(config =>
      config.interfaces.some(iface => iface.alternates.some(alt =>
        alt.interfaceClass === 2 && alt.interfaceSubclass === 2,
      )),
    )
    if (!configuration) throw new Error('USB 设备没有 FZ 所需的 CDC 串口接口。')
    if (this.device.configuration?.configurationValue !== configuration.configurationValue) {
      await this.device.selectConfiguration(configuration.configurationValue)
    }
    const interfaces = this.device.configuration!.interfaces
    const control = interfaces.find(iface => iface.alternates.some(alt =>
      alt.interfaceClass === 2 && alt.interfaceSubclass === 2,
    ))!
    this.controlInterface = control.interfaceNumber
    // Flipper CDC0 is its CLI; a possible second CDC pair must not be selected.
    const data = interfaces.find(iface => iface.interfaceNumber === this.controlInterface + 1)
    const dataAlternate = data?.alternates.find(alt => alt.interfaceClass === 10)
    const input = dataAlternate?.endpoints.find(ep => ep.type === 'bulk' && ep.direction === 'in')
    const output = dataAlternate?.endpoints.find(ep => ep.type === 'bulk' && ep.direction === 'out')
    if (!data || !dataAlternate || !input || !output) {
      throw new Error('未找到 FZ 的 USB 数据收发端点。')
    }
    await this.device.claimInterface(control.interfaceNumber)
    await this.device.claimInterface(data.interfaceNumber)
    if (data.alternate.alternateSetting !== dataAlternate.alternateSetting) {
      await this.device.selectAlternateInterface(data.interfaceNumber, dataAlternate.alternateSetting)
    }

    const coding = new Uint8Array([0, 0, 0, 0, 0, 0, 8])
    new DataView(coding.buffer).setUint32(0, options.baudRate, true)
    const result = await this.device.controlTransferOut({
      requestType: 'class', recipient: 'interface', request: 0x20,
      value: 0, index: this.controlInterface,
    }, coding)
    if (result.status !== 'ok') throw new Error('FZ 未接受 USB 串口参数。')

    this.readable = new ReadableStream<Uint8Array>({
      pull: async controller => {
        const result = await this.device.transferIn(input.endpointNumber, input.packetSize)
        if (result.status !== 'ok' || !result.data) throw new Error('USB 接收失败，请检查 FZ 连接。')
        controller.enqueue(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength))
      },
    })
    this.writable = new WritableStream<Uint8Array>({
      write: async bytes => {
        const result = await this.device.transferOut(output.endpointNumber, new Uint8Array(bytes))
        if (result.status !== 'ok' || result.bytesWritten !== bytes.length) {
          throw new Error('USB 数据没有完整写入 FZ，请重新连接。')
        }
      },
    })
    navigator.usb.addEventListener('disconnect', this.handleDisconnect)
  }

  async setSignals(signals: SerialOutputSignals): Promise<void> {
    const result = await this.device.controlTransferOut({
      requestType: 'class', recipient: 'interface', request: 0x22,
      value: (signals.dataTerminalReady ? 1 : 0) | (signals.requestToSend ? 2 : 0),
      index: this.controlInterface,
    })
    if (result.status !== 'ok') throw new Error('FZ 未接受 USB 连接信号。')
  }

  async close(): Promise<void> {
    navigator.usb.removeEventListener('disconnect', this.handleDisconnect)
    if (this.device.opened) {
      await this.setSignals({ dataTerminalReady: false }).catch(() => undefined)
      await this.device.close()
    }
    this.readable = null
    this.writable = null
  }
}
