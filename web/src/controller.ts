import { computed, defineComponent, reactive, ref, shallowRef } from 'vue'
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

    const flipper = new FlipperSerial(() => {
      connected.value = false
      message.value = 'USB 已断开，重新连接后可以继续。'
      messageKind.value = 'error'
      if (!busy.value) void flipper.close()
    })

    function setColor(color: Rgb) {
      editingGroup.value.color = color
      activeScene.value = ''
    }

    function toggleGroup(id: number) {
      const group = groups[id - 1]!
      group.enabled = !group.enabled
      if (group.enabled) editingGroupId.value = id
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
      activeScene.value = scene.name
      message.value = `已载入「${scene.name}」，点击“发送颜色”应用。`
      messageKind.value = 'idle'
    }

    function targetColor(id: number): Rgb {
      return groups[id - 1]!.enabled
        ? groups[id - 1]!.color
        : heldColors.value[id - 1]!
    }

    async function perform(action: 'connect' | 'disconnect' | 'send' | 'off') {
      busy.value = true
      messageKind.value = 'idle'
      const progress = (text: string) => {
        message.value = text
      }
      try {
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
          message.value = '全部关灯指令已发送。'
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
        await flipper.close()
        connected.value = false
        const cancelled =
          error instanceof DOMException && error.name === 'NotFoundError'
        message.value = cancelled
          ? '未选择设备。若列表为空，请检查手机 OTG 和数据线，或切换 USB 连接方式再试。'
          : error instanceof Error
            ? error.message
            : String(error)
        messageKind.value = cancelled ? 'idle' : 'error'
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
      toggleGroup,
      selectAll,
      loadScene,
      targetColor,
      perform,
    }
  },
})
