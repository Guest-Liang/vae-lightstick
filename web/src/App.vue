<script lang="ts" src="./controller.ts"></script>

<template>
  <div class="app-shell">
    <header class="site-header">
      <a href="./" class="brand" aria-label="VAE Lightstick 首页">
        <svg class="brand-mark" width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <rect width="40" height="40" rx="12" fill="currentColor" />
          <path d="m10 12 10 18 10-18M15 12l5 9 5-9" stroke="#FF9D77" stroke-width="2.5" stroke-linecap="round"
            stroke-linejoin="round" />
        </svg>
        <span>VAE <span class="brand-light">LIGHTSTICK</span><small>把现场的光，带回家。</small></span>
      </a>
      <div class="header-right">
        <select v-if="!connected && (serialSupported || usbSupported)" v-model="connectionMethod"
          class="connection-method" aria-label="USB 连接方式" :disabled="busy">
          <option value="serial" :disabled="!serialSupported">电脑 USB 串口</option>
          <option value="usb" :disabled="!usbSupported">安卓 USB 直连</option>
        </select>
        <span class="connection-badge" :class="{ connected }"><i />{{ connected ? deviceName : '设备未连接' }}</span>
        <button v-if="!connected" class="button button-connect" :disabled="busy || !connectionSupported"
          @click="perform('connect')">
          <Icon name="usb" />{{ busy ? '正在连接…' : '连接 Flipper' }}
        </button>
        <button v-else class="button button-disconnect" :disabled="busy" @click="perform('disconnect')">
          <Icon name="disconnect" />断开连接
        </button>
      </div>
    </header>

    <main>
      <div class="page-heading">
        <div>
          <p class="eyebrow"><span />YOUR OWN LIGHT SHOW</p>
          <h1>灯光控制台<span>.</span></h1>
          <p class="heading-caption">选好分组，调一束属于你的光。</p>
        </div>
        <button class="button button-off" :disabled="!connected || busy" @click="perform('off')">
          <Icon name="power" />全部关灯
        </button>
      </div>

      <div v-if="!connectionSupported" class="compatibility-message" role="alert">
        <Icon name="info" /><span>当前浏览器无法通过 USB 连接 FZ。电脑使用 Chrome／Edge，安卓使用支持 USB 设备访问的浏览器，并通过 HTTPS 打开页面。iPhone 的普通
          Safari 暂不支持此 USB 连接。</span>
      </div>

      <div class="workspace">
        <fieldset class="control-column" :disabled="busy">
          <section class="panel group-panel" aria-labelledby="group-heading">
            <div class="section-heading">
              <div class="section-title">
                <span class="step-number">01</span>
                <h2 id="group-heading">控制分组</h2>
                <span class="count-badge">{{ selection.length }} / 8</span>
              </div>
              <button class="text-button" @click="selectAll">
                {{ selection.length === 8 ? '取消全选' : '全选' }}
              </button>
            </div>
            <p class="section-caption">打开开关，让这个分组参与本次发送。</p>
            <div class="group-grid" :class="{ expanded: visibleGroups.length > 2 }">
              <label v-for="group in visibleGroups" :key="group.id" class="group-card"
                :class="{ selected: group.enabled }">
                <div class="group-card-top">
                  <span class="group-id">G{{ group.id }}</span><span class="toggle"><input type="checkbox" role="switch"
                      :aria-label="`控制 G${group.id}`" :checked="group.enabled" @change="toggleGroup(group.id)" /><span
                      class="toggle-track" /></span>
                </div>
                <div class="group-card-bottom">
                  <span>第 {{ group.id }} 组</span><span class="group-color"><i :style="{
                    background: displayColor(targetColor(group.id)),
                  }" />{{ group.enabled ? '参与控制' : '保留设定' }}</span>
                </div>
              </label>
            </div>
            <button class="expand-groups" :aria-expanded="showAll" @click="showAll = !showAll">
              {{ showAll ? '收起未选分组' : '展开全部 8 个分组'
              }}
              <Icon name="chevron" :class="{ rotated: showAll }" />
            </button>
            <p class="group-footnote">
              开关只选择分组，不会立即发射。未选分组沿用上次已发送目标色，首次为关闭。
            </p>
          </section>

          <section class="panel color-panel" aria-labelledby="color-heading">
            <div class="section-heading">
              <div class="section-title">
                <span class="step-number">02</span>
                <h2 id="color-heading">64 色调色盘</h2>
              </div>
              <span class="small-label">每分量 4 档</span>
            </div>
            <p class="section-caption">
              先选调色分组，再点颜色。每组独立保存，黑色表示关闭。
            </p>
            <div class="palette-groups" role="group" aria-label="选择当前调色分组">
              <button v-for="group in selection" :key="group.id" type="button" class="palette-group"
                :class="{ active: editingGroupId === group.id }" :aria-label="`调色 G${group.id}`"
                :aria-pressed="editingGroupId === group.id" @click="editingGroupId = group.id">
                <i :style="{ background: displayColor(group.color) }" />G{{ group.id }}
              </button>
            </div>
            <div class="palette-summary">
              <span class="current-color-chip" :style="{ background: currentHex }" />
              <div class="current-color-info">
                <span>G{{ editingGroupId }} 配色 <strong>{{ currentHex }}</strong></span>
                <small>RGB {{ currentColor.join(' · ') }}</small>
              </div>
            </div>
            <div class="palette-grid" role="group" aria-label="64 色调色盘">
              <button v-for="item in palette" :key="item.hex" type="button" class="palette-swatch"
                :disabled="!editingGroup.enabled" :class="{ active: currentHex === item.hex }"
                :style="{ background: item.hex }" :aria-label="item.hex === '#000000'
                  ? '关灯色 #000000'
                  : `选择颜色 ${item.hex}`
                  " :aria-pressed="currentHex === item.hex" :title="`${item.hex} · RGB ${item.color.join(', ')}`"
                @click="setColor(item.color)">
                <span v-if="currentHex === item.hex" class="palette-check">
                  <Icon name="check" />
                </span>
                <span v-else-if="item.hex === '#000000'" class="palette-off-label">关</span>
              </button>
            </div>
            <p v-if="!selection.length" class="selection-hint">
              先打开一个分组开关，再为它调色。
            </p>
          </section>

          <section class="send-panel">
            <label class="auto-off-option"><span class="toggle toggle-small"><input v-model="autoOff" type="checkbox"
                  role="switch" aria-label="2 秒后自动关灯" /><span class="toggle-track" /></span><span>2
                秒后自动关灯<small>只关闭本次选择的分组</small></span></label>
            <button class="button button-send" :disabled="!connected || !selection.length || busy"
              @click="perform('send')">
              <span>{{ busy ? '正在处理…' : '发送颜色'
                }}<small v-if="selection.length && !busy">{{ selection.length }} 个分组</small></span>
              <Icon name="arrow" />
            </button>
          </section>
        </fieldset>

        <aside class="preview-column">
          <section class="preview-panel" aria-labelledby="preview-heading">
            <div class="preview-header">
              <h2 id="preview-heading">配色预览</h2>
              <span><i />PREVIEW</span>
            </div>
            <div class="lightstick-stage">
              <div class="stage-grid" />
              <div class="stage-ring ring-one" />
              <div class="stage-ring ring-two" />
              <div v-for="id in [7, 8]" :key="id" class="stick-position" :class="`stick-${id}`"
                :style="{ '--light': displayColor(targetColor(id)) }">
                <div class="stick-object" :class="{
                  'is-lit': displayColor(targetColor(id)) !== '#000000',
                }">
                  <div class="stick-tube"><span /></div>
                  <div class="stick-collar" />
                  <div class="stick-handle"><span>VAE</span><i /></div>
                </div>
                <div class="stick-label">
                  <span>G{{ id }}</span><i :style="{ background: displayColor(targetColor(id)) }" />{{
                    hexColor(targetColor(id)) }}
                </div>
              </div>
            </div>
            <div class="preview-footer">
              <span class="preview-line" />
              <p>光不止于散场<span>KEEP THE MOMENT ALIVE</span></p>
              <span class="preview-line" />
            </div>
            <p class="preview-note">
              预览显示待发送配色；灯棒不会回传当前状态。
            </p>
          </section>

          <section class="panel scene-panel" aria-labelledby="scene-heading">
            <div class="section-heading">
              <div class="section-title">
                <Icon name="sparkle" />
                <h2 id="scene-heading">我的双色</h2>
              </div>
              <span class="small-label">G7 + G8</span>
            </div>
            <p class="section-caption">载入一个组合，再点击发送。</p>
            <div class="scene-list">
              <button v-for="scene in scenes" :key="scene.name" class="scene-button"
                :class="{ active: activeScene === scene.name }" :disabled="busy" @click="loadScene(scene)">
                <span class="scene-colors"><i v-for="(color, index) in scene.colors" :key="index"
                    :style="{ background: displayColor(color) }" /></span><span class="scene-text">{{ scene.name
                    }}<small>{{ scene.caption }}</small></span>
                <Icon :name="activeScene === scene.name ? 'check' : 'arrow'" />
              </button>
            </div>
          </section>
        </aside>
      </div>

      <div class="status-line" :class="messageKind" role="status" aria-live="polite">
        <span v-if="busy" class="spinner" />
        <Icon v-else :name="messageKind === 'success' ? 'check' : 'info'" />
        <p>{{ message }}</p>
        <span class="status-transport">{{
          connected ? firmware || 'USB 已连接' : transportLabel
        }}</span>
      </div>

      <details class="usage-help">
        <summary>第一次使用？
          <Icon name="chevron" />
        </summary>
        <ol>
          <li>
            将开机的 Flipper Zero 通过数据线连接电脑或安卓手机，插好 microSD
            卡，并停在设备主界面。
          </li>
          <li>
            电脑选择“电脑 USB 串口”；安卓选择“安卓 USB 直连”。若手机的串口设备列表为空，可用 USB 直连方式重新选择设备，并确认已开启 OTG。
          </li>
          <li>
            关闭占用串口的 qFlipper 或其他网页，点击“连接
            Flipper”，在浏览器中选择设备。
          </li>
          <li>
            打开需要控制的分组开关，调色或载入双色预设，再点击“发送颜色”。
          </li>
          <li>
            “全部关灯”会向 G1–G8
            发送关闭指令，与当前分组选择无关。关闭自动关灯后，灯光会保留到下一条指令或断电。
          </li>
        </ol>
        <p>
          需要固件提供可用的 subghz JavaScript
          模块。连接过程会准备控制文件，但不会发射无线信号。
        </p>
      </details>
    </main>

    <footer class="site-footer">
      <span>VAE LIGHTSTICK<span class="footer-separator">/</span>独立开源研究</span><span>感谢
        <a href="https://github.com/HansZ8/EncoreLightSticks" target="_blank" rel="noreferrer">HansZ8
          <Icon name="external" />
        </a>
        与
        <a href="https://github.com/wuhan005/LightStick" target="_blank" rel="noreferrer">wuhan005
          <Icon name="external" />
        </a>
        的公开工作</span>
    </footer>
  </div>
</template>
