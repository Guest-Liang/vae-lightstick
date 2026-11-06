import { computed, defineComponent, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import Icon from './Icon.vue'
import { FlipperSerial } from './flipper'
import type { ConnectionMethod, DeviceState, EffectId } from './flipper'
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
    const lastLiveMs = ref(0)
    const liveColors = shallowRef<GroupColors>(Array(8).fill(OFF))
    let pendingLiveColors: GroupColors | null = null
    let liveTask: Promise<void> | null = null
    let statusTask: Promise<void> | null = null
    let statusTimer = 0
    const showAll = ref(false)
    const autoOff = ref(true)
    const autoOffSeconds = ref(2)
    const deviceState = shallowRef<DeviceState | null>(null)
    const effects: { id: EffectId; name: string; caption: string }[] = [
      { id: 1, name: '红蓝交换', caption: '相邻已选组红蓝交替，两步一轮。' },
      { id: 2, name: '四色轮播', caption: '已选组同步轮播红、绿、蓝、白。' },
      { id: 3, name: '明灭交替', caption: '各组按自己的当前配色亮起，再一起熄灭。' },
    ]
    const effectId = ref<EffectId>(1)
    const effectInterval = ref(1000)
    const effectLoops = ref(5)
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
    const activityLabel = computed(() => {
      if (!connected.value) return '设备未连接'
      const state = deviceState.value
      if (state?.mode === 'timer') return `约 ${Math.ceil(state.remainingMs / 1000)} 秒后关闭所选组`
      if (state?.mode === 'effect') {
        const name = effects.find(effect => effect.id === state.effect)?.name ?? '灯效'
        return `${name} · 第 ${state.step} 步${state.total ? ` / ${state.total}` : ' · 连续播放'}`
      }
      return liveMode.value ? '实时调色 · 手动关灯' : `${deviceName.value} 已连接`
    })
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
      window.clearInterval(statusTimer)
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
      if (!busy.value && !liveTask && !statusTask) void flipper.close()
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

    function updateDevice(state: DeviceState) {
      deviceState.value = state
      heldColors.value = state.colors
      if (!state.ok) {
        message.value = 'FZ 最近一次发射失败，请检查设备后重新发送。'
        messageKind.value = 'error'
      }
    }

    // Poll only while the command lane is idle. User actions wait for this one
    // outstanding read, so CLI replies cannot be consumed by the wrong caller.
    statusTimer = window.setInterval(() => {
      if (!connected.value || busy.value || liveTask || statusTask) return
      statusTask = (async () => {
        try {
          const previousMode = deviceState.value?.mode
          const state = await flipper.state()
          updateDevice(state)
          if (liveMode.value && !liveTask) liveColors.value = state.colors
          if (previousMode && previousMode !== 'idle' && state.mode === 'idle' && state.ok) {
            message.value = previousMode === 'timer' ? 'FZ 已完成定时关灯。' : '灯效已结束，FZ 已发送所选组的关闭指令。'
            messageKind.value = 'success'
          }
        } catch (error) {
          await handleFailure(error)
        } finally {
          statusTask = null
        }
      })()
    }, 1000)

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
        await statusTask
        while (liveMode.value && pendingLiveColors) {
          const colors = pendingLiveColors
          pendingLiveColors = null
          const result = await flipper.sendLive(colors)
          lastLiveMs.value = result.elapsedMs
          updateDevice(result.state)
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
      if (connected.value && deviceState.value?.mode === 'effect') return heldColors.value[id - 1]!
      return groups[id - 1]!.enabled
        ? groups[id - 1]!.color
        : heldColors.value[id - 1]!
    }

    async function perform(action: 'connect' | 'disconnect' | 'send' | 'off' | 'live' | 'play' | 'stop') {
      if (action === 'send' && autoOff.value &&
        (!Number.isInteger(autoOffSeconds.value) || autoOffSeconds.value < 1 || autoOffSeconds.value > 3600)) {
        message.value = '关灯时间请填写 1～3600 之间的整数秒。'
        messageKind.value = 'error'
        return
      }
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
        await statusTask
        if (action !== 'connect' && action !== 'disconnect' && !connected.value) return
        if (action === 'connect') {
          const device = await flipper.connect(progress, connectionMethod.value)
          deviceName.value = device.name
          firmware.value = device.firmware
          updateDevice(await flipper.state())
          connected.value = true
          message.value = `${device.name} 已就绪，可以发送颜色了。`
        } else if (action === 'disconnect') {
          await flipper.close()
          connected.value = false
          message.value = 'USB 已断开，FZ 本机仍可操作，已启动的灯效和定时会继续执行。'
        } else if (action === 'off') {
          updateDevice(await flipper.off(progress))
          liveColors.value = Array(8).fill(OFF)
          message.value = '全部关灯指令已发送。'
        } else if (action === 'stop') {
          updateDevice(await flipper.stop())
          message.value = '已停止灯效或定时，并发送原先所选组的关闭指令。'
        } else if (action === 'live') {
          if (liveMode.value) {
            liveMode.value = false
            updateDevice(await flipper.off(progress))
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
            lastLiveMs.value = 0
            activeScene.value = ''
            if (selection.value.length) {
              updateDevice(await flipper.send(colors, null, 0, progress))
              message.value = `实时模式已开启，${selectionLabel.value} 为白色。划过色块即可调色，关灯需手动操作。`
            } else {
              if (deviceState.value?.mode !== 'idle') updateDevice(await flipper.stop())
              liveColors.value = heldColors.value
              message.value = '实时模式已开启，先打开需要控制的分组开关，再划过色块调色。'
            }
          }
        } else {
          const colors = groups.map(group => group.enabled ? group.color : heldColors.value[group.id - 1]!)
          if (action === 'play') {
            const mask = selection.value.reduce((value, group) => value | (1 << (group.id - 1)), 0)
            message.value = '正在启动灯效…'
            updateDevice(await flipper.play(effectId.value, mask, colors, effectInterval.value, effectLoops.value))
            message.value = '灯效已交给 FZ 播放，完成或停止后会关闭本次所选组。'
          } else {
            const after = autoOff.value
              ? colors.map((color, index) => groups[index]!.enabled ? OFF : color)
              : null
            updateDevice(await flipper.send(colors, after, autoOffSeconds.value, progress))
            message.value = autoOff.value
              ? `${selectionLabel.value} 颜色已发送，FZ 将在 ${autoOffSeconds.value} 秒后关闭所选组。`
              : `${selectionLabel.value} 颜色指令已发送。`
          }
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
      autoOffSeconds,
      deviceState,
      activityLabel,
      effects,
      effectId,
      effectInterval,
      effectLoops,
      liveMode,
      liveUnified,
      liveSending,
      lastLiveMs,
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
