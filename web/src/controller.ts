import { computed, defineComponent, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import Icon from './Icon.vue'
import { FlipperSerial } from './flipper'
import type { ConnectionMethod } from './flipper'
import { OFF, displayColor, hexColor } from './protocol'
import type { GroupColors, Rgb } from './protocol'

export default defineComponent({
  name: 'LightstickConsole',
  components: { Icon },
  setup() {
    const groups = reactive(
      Array.from({ length: 8 }, (_, index) => ({
        id: index + 1,
        enabled: index >= 6,
        color: (index >= 6 ? [255, 85, 0] : OFF) as Rgb,
      })),
    )
    const editingGroupId = ref(7)
    const editingGroup = computed(() => groups[editingGroupId.value - 1]!)
    const currentColor = computed(() => editingGroup.value.color)
    const heldColors = shallowRef<GroupColors>(Array(8).fill(OFF))
    const liveMode = ref(false)
    const liveUnified = ref(true)
    const liveSending = ref(false)
    const liveColors = shallowRef<GroupColors>(Array(8).fill(OFF))
    let pendingLiveColors: GroupColors | null = null
    let liveTask: Promise<void> | null = null
    const showAll = ref(false)
    const autoOff = ref(true)
    const connected = ref(false)
    const busy = ref(false)
    const deviceName = ref('Flipper Zero')
    const firmware = ref('')
    const message = ref('连接 Flipper，让配色从屏幕走到手里。')
    const messageKind = ref<'idle' | 'success' | 'error'>('idle')
    const activeScene = ref('')
    const serialSupported = 'serial' in navigator && window.isSecureContext
    const usbSupported = 'usb' in navigator && window.isSecureContext
    const connectionMethod = ref<ConnectionMethod>(
      usbSupported && (/Android/i.test(navigator.userAgent) || !serialSupported) ? 'usb' : 'serial',
    )
    const connectionSupported = computed(() =>
      connectionMethod.value === 'usb' ? usbSupported : serialSupported,
    )
    const transportLabel = computed(() => connectionMethod.value === 'usb' ? 'USB · WebUSB' : 'USB · Web Serial')
    const selection = computed(() => groups.filter((group) => group.enabled))
    const visibleGroups = computed(() =>
      showAll.value
        ? groups
        : groups.filter((group) => group.id >= 7 || group.enabled),
    )
    const currentHex = computed(() => hexColor(currentColor.value))
    const selectionLabel = computed(() =>
      selection.value.map((group) => `G${group.id}`).join('、'),
    )
    const palette = Array.from({ length: 64 }, (_, index) => {
      const color: Rgb = [
        (index >> 4) * 85,
        ((index >> 2) & 3) * 85,
        (index & 3) * 85,
      ]
      return { color, hex: hexColor(color) }
    })
    const scenes: {
      name: string
      caption: string
      colors: readonly [Rgb, Rgb]
    }[] = [
        {
          name: '红蓝双区',
          caption: 'G7 红色 · G8 蓝色',
          colors: [
            [255, 0, 0],
            [0, 0, 255],
          ],
        },
        {
          name: '蓝红互换',
          caption: 'G7 蓝色 · G8 红色',
          colors: [
            [0, 0, 255],
            [255, 0, 0],
          ],
        },
        {
          name: '紫青相映',
          caption: 'G7 紫色 · G8 青色',
          colors: [
            [170, 0, 255],
            [0, 255, 255],
          ],
        },
        {
          name: '白色同亮',
          caption: 'G7 白色 · G8 白色',
          colors: [
            [255, 255, 255],
            [255, 255, 255],
          ],
        },
      ]

    const shouldWarnOnLeave = computed(() =>
      [...heldColors.value, ...(liveMode.value ? liveColors.value : [])].some((color) =>
        color.some((component) => component !== 0),
      ),
    )
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    watch(shouldWarnOnLeave, (warn) => {
      if (warn) window.addEventListener('beforeunload', warnBeforeLeave)
      else window.removeEventListener('beforeunload', warnBeforeLeave)
    })
    onBeforeUnmount(() => {
      window.removeEventListener('beforeunload', warnBeforeLeave)
      liveMode.value = false
      pendingLiveColors = null
    })

    const flipper = new FlipperSerial(() => {
      connected.value = false
      liveMode.value = false
      pendingLiveColors = null
      message.value = 'USB 已断开，重新连接后可以继续。'
      messageKind.value = 'error'
      if (!busy.value && !liveTask) void flipper.close()
    })

    async function handleFailure(error: unknown) {
      liveMode.value = false
      pendingLiveColors = null
      await flipper.close()
      connected.value = false
      const cancelled = error instanceof DOMException && error.name === 'NotFoundError'
      message.value = cancelled
        ? '未选择设备。若列表为空，请检查手机 OTG 和数据线，或切换 USB 连接方式再试。'
        : error instanceof Error ? error.message : String(error)
      messageKind.value = cancelled ? 'idle' : 'error'
    }

    function queueLive(colors: GroupColors) {
      if (colors.every((color, index) =>
        color.every((component, channel) => component === liveColors.value[index]![channel]),
      )) return
      liveColors.value = colors
      pendingLiveColors = colors
      if (!liveTask) liveTask = flushLive()
    }

    async function flushLive() {
      liveSending.value = true
      messageKind.value = 'idle'
      try {
        while (liveMode.value && pendingLiveColors) {
          const colors = pendingLiveColors
          pendingLiveColors = null
          await flipper.sendLive(colors)
          heldColors.value = colors
        }
        if (liveMode.value) {
          message.value = '实时颜色已发送。划过色块继续调色，关灯请点“全部关灯”。'
          messageKind.value = 'success'
        }
      } catch (error) {
        await handleFailure(error)
      } finally {
        liveSending.value = false
        liveTask = null
      }
    }

    function setColor(color: Rgb, event?: MouseEvent) {
      // A touch drag may synthesize a click on its starting swatch after pointerup.
      if (liveMode.value && event?.detail) return
      if (liveMode.value && liveUnified.value) {
        for (const group of selection.value) group.color = color
      } else editingGroup.value.color = color
      activeScene.value = ''
      if (liveMode.value) {
        queueLive(liveColors.value.map((previous, index) => {
          const group = groups[index]!
          return group.enabled && (liveUnified.value || group.id === editingGroupId.value)
            ? group.color : previous
        }))
      }
    }

    function paintPalette(event: PointerEvent) {
      if (!liveMode.value || busy.value || !event.isPrimary) return
      const swatch = document.elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLButtonElement>('button[data-palette-index]')
      if (!swatch || !(event.currentTarget as HTMLElement).contains(swatch) || swatch.disabled) return
      const item = palette[Number(swatch.dataset.paletteIndex)]
      if (item) setColor(item.color)
    }

    function toggleGroup(id: number) {
      const group = groups[id - 1]!
      group.enabled = !group.enabled
      if (group.enabled) {
        editingGroupId.value = id
        liveUnified.value = false
      }
      else if (editingGroupId.value === id && selection.value.length)
        editingGroupId.value = selection.value[0]!.id
      activeScene.value = ''
    }

    function selectAll() {
      const enabled = selection.value.length !== 8
      for (const group of groups) {
        group.enabled = enabled
      }
      if (enabled) showAll.value = true
      activeScene.value = ''
    }

    function loadScene(scene: (typeof scenes)[number]) {
      for (const group of groups) group.enabled = group.id >= 7
      groups[6]!.color = scene.colors[0]
      groups[7]!.color = scene.colors[1]
      editingGroupId.value = 7
      liveUnified.value = false
      activeScene.value = scene.name
      if (liveMode.value) {
        queueLive(liveColors.value.map((previous, index) =>
          index >= 6 ? scene.colors[index - 6]! : previous,
        ))
      }
      message.value = liveMode.value
        ? `已选择「${scene.name}」，实时配色已更新。`
        : `已载入「${scene.name}」，点击“发送颜色”应用。`
      messageKind.value = 'idle'
    }

    function targetColor(id: number): Rgb {
      if (liveMode.value) return liveColors.value[id - 1]!
      return groups[id - 1]!.enabled
        ? groups[id - 1]!.color
        : heldColors.value[id - 1]!
    }

    async function perform(action: 'connect' | 'disconnect' | 'send' | 'off' | 'live') {
      busy.value = true
      messageKind.value = 'idle'
      const progress = (text: string) => {
        message.value = text
      }
      try {
        // Stop queued colors before OFF, disconnect, or leaving live mode.
        if (action === 'off' || action === 'disconnect' || (action === 'live' && liveMode.value))
          pendingLiveColors = null
        if (action === 'disconnect') liveMode.value = false
        await liveTask
        if (action !== 'connect' && action !== 'disconnect' && !connected.value) return
        if (action === 'connect') {
          const device = await flipper.connect(progress, connectionMethod.value)
          deviceName.value = device.name
          firmware.value = device.firmware
          connected.value = true
          message.value = `${device.name} 已就绪，可以发送颜色了。`
        } else if (action === 'disconnect') {
          await flipper.close()
          connected.value = false
          message.value = '已断开 Flipper。配色仍保留在页面中。'
        } else if (action === 'off') {
          await flipper.off(progress)
          heldColors.value = Array(8).fill(OFF)
          liveColors.value = Array(8).fill(OFF)
          message.value = '全部关灯指令已发送。'
        } else if (action === 'live') {
          if (liveMode.value) {
            liveMode.value = false
            await flipper.off(progress)
            heldColors.value = Array(8).fill(OFF)
            liveColors.value = Array(8).fill(OFF)
            message.value = '已退出实时模式，并已发送全部关灯指令。'
          } else {
            const white: Rgb = [255, 255, 255]
            const colors = heldColors.value.map((color, index) =>
              groups[index]!.enabled ? white : color,
            )
            for (const group of selection.value) group.color = white
            liveColors.value = colors
            liveMode.value = true
            activeScene.value = ''
            if (selection.value.length) {
              await flipper.send(colors, null, progress)
              heldColors.value = colors
              message.value = `实时模式已开启，${selectionLabel.value} 为白色。划过色块即可调色，关灯需手动操作。`
            } else {
              message.value = '实时模式已开启，先打开需要控制的分组开关，再划过色块调色。'
            }
          }
        } else {
          const colors = groups.map((group) => targetColor(group.id))
          const after = autoOff.value
            ? colors.map((color, index) =>
              groups[index]!.enabled ? OFF : color,
            )
            : null
          await flipper.send(colors, after, progress)
          heldColors.value = after ?? colors
          message.value = autoOff.value
            ? `${selectionLabel.value} 颜色指令已发送，并已追加关灯指令。`
            : `${selectionLabel.value} 颜色指令已发送。`
        }
        messageKind.value = 'success'
      } catch (error) {
        await handleFailure(error)
      } finally {
        busy.value = false
      }
    }

    return {
      groups,
      currentColor,
      editingGroupId,
      editingGroup,
      showAll,
      autoOff,
      liveMode,
      liveUnified,
      liveSending,
      connected,
      busy,
      deviceName,
      firmware,
      message,
      messageKind,
      serialSupported,
      usbSupported,
      connectionMethod,
      connectionSupported,
      transportLabel,
      selection,
      visibleGroups,
      currentHex,
      selectionLabel,
      palette,
      scenes,
      activeScene,
      hexColor,
      displayColor,
      setColor,
      paintPalette,
      toggleGroup,
      selectAll,
      loadScene,
      targetColor,
      perform,
    }
  },
})
