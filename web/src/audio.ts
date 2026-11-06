import type { Rgb } from './protocol'

export type MusicEffect = 'cycle' | 'spectrum'
export type MusicFrame = { colors: readonly [Rgb, Rgb] }
export const MUSIC_SPECTRUM_POINTS = 96
export const MUSIC_SPECTRUM_MAX_HZ = 24000

const PALETTE: readonly Rgb[] = [
  [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1], [1, 0, 1],
]

/** Local playback and analysis share one media element; only colors leave the browser. */
export class MusicPlayer {
  readonly audio = new Audio()
  effect: MusicEffect = 'cycle'
  sensitivity = 1
  private url = ''
  private context?: AudioContext
  private analyser?: AnalyserNode
  private visualAnalyser?: AnalyserNode
  private gain?: GainNode
  private volume = 0.8
  private samples = new Float32Array(2048)
  private spectrum = new Float32Array(1024)
  private visualBins = new Float32Array(4096)
  private animation = 0
  private peak = 0.04
  private envelope = 0
  private bandEnvelope = [0, 0, 0]
  private onsetAverage = 0
  private previousOnset = 0
  private lastBeat = -Infinity
  private lastFrame = -Infinity
  private lastTick = 0
  private phase = 5
  private levels = [0, 0, 0, 0]

  load(file: File) {
    this.pause()
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = URL.createObjectURL(file)
    this.audio.preload = 'metadata'
    this.audio.src = this.url
    this.audio.load()
    this.resetAnalysis()
  }

  async prepare() {
    if (!this.context) {
      this.context = new AudioContext()
      this.analyser = this.context.createAnalyser()
      this.analyser.fftSize = 2048
      this.analyser.smoothingTimeConstant = 0
      this.visualAnalyser = this.context.createAnalyser()
      this.visualAnalyser.fftSize = 8192
      this.visualAnalyser.smoothingTimeConstant = 0
      this.gain = this.context.createGain()
      this.gain.gain.value = this.volume
      const source = this.context.createMediaElementSource(this.audio)
      source.connect(this.analyser)
      source.connect(this.visualAnalyser)
      source.connect(this.gain)
      this.gain.connect(this.context.destination)
    }
    await this.context.resume()
  }

  async play(onFrame: (frame: MusicFrame) => void, onVisuals: (energy: number, spectrum: readonly number[]) => void) {
    await this.audio.play()
    const analyser = this.analyser!
    const visualAnalyser = this.visualAnalyser!
    const binHz = this.context!.sampleRate / analyser.fftSize
    const bandsHz: readonly (readonly [number, number])[] = [[50, 250], [250, 2000], [2000, 8000]]
    const ranges = bandsHz.map(([low, high]) => [
      Math.max(1, Math.ceil(low / binHz)),
      Math.min(analyser.frequencyBinCount, Math.ceil(high / binHz)),
    ] as const)
    // A separate, longer FFT resolves bass detail without slowing beat detection.
    const visualBinHz = this.context!.sampleRate / visualAnalyser.fftSize
    const spectrumRanges = Array.from({ length: MUSIC_SPECTRUM_POINTS }, (_, index) => {
      const center = MUSIC_SPECTRUM_MAX_HZ ** (index / (MUSIC_SPECTRUM_POINTS - 1)) / visualBinHz
      const start = Math.ceil(MUSIC_SPECTRUM_MAX_HZ ** ((index - 0.5) / (MUSIC_SPECTRUM_POINTS - 1)) / visualBinHz)
      const end = Math.min(visualAnalyser.frequencyBinCount,
        Math.ceil(MUSIC_SPECTRUM_MAX_HZ ** ((index + 0.5) / (MUSIC_SPECTRUM_POINTS - 1)) / visualBinHz))
      return { center, start, end }
    })
    this.lastTick = performance.now()
    this.lastFrame = -Infinity
    let lastMeterTick = this.lastTick
    let meterEnergy = 0
    let visualSpectrum = Array<number>(MUSIC_SPECTRUM_POINTS).fill(0)
    const tick = () => {
      this.animation = window.requestAnimationFrame(tick)
      if (this.audio.paused || this.audio.seeking) return
      const now = performance.now()
      const meterElapsed = Math.min(now - lastMeterTick, 100)
      lastMeterTick = now
      analyser.getFloatTimeDomainData(this.samples)
      const rms = Math.sqrt(this.samples.reduce((sum, value) => sum + value * value, 0) / this.samples.length)
      this.peak = Math.max(0.015, rms, this.peak * Math.exp(-meterElapsed / 4000))
      const energy = rms < 0.0015 ? 0 : Math.min(1, rms / this.peak * this.sensitivity)
      // Visuals follow the display refresh rate, without the radio's peak hold.
      meterEnergy += (energy - meterEnergy) * (1 - Math.exp(-meterElapsed / (energy > meterEnergy ? 25 : 120)))
      visualAnalyser.getFloatFrequencyData(this.visualBins)
      visualSpectrum = spectrumRanges.map(({ center, start, end }, index) => {
        let peakDb = -80
        for (let bin = start; bin < end; bin++) peakDb = Math.max(peakDb, this.visualBins[bin]!)
        // Interpolate narrow low-frequency ranges between neighbouring FFT bins.
        if (start === end && center < this.visualBins.length - 1) {
          const left = Math.floor(center)
          const fraction = center - left
          peakDb = Math.max(-80, this.visualBins[left]!) * (1 - fraction) +
            Math.max(-80, this.visualBins[left + 1]!) * fraction
        }
        const target = Math.max(0, Math.min(1, (peakDb + 80) / 70))
        const previous = visualSpectrum[index]!
        return previous + (target - previous) * (1 - Math.exp(-meterElapsed / (target > previous ? 20 : 140)))
      })
      onVisuals(meterEnergy, visualSpectrum)

      // Keep lighting analysis and radio updates at their own rates.
      if (now - this.lastTick < 33) return
      const elapsed = Math.min(now - this.lastTick, 100)
      this.lastTick = now
      analyser.getFloatFrequencyData(this.spectrum)
      const bands = ranges.map(([start, end]) => {
        let power = 0
        for (let bin = start; bin < end; bin++) power += 10 ** (this.spectrum[bin]! / 10)
        return Math.sqrt(power)
      })
      const onset = bands[0]! + rms * 0.5
      const beat = rms > 0.003 && now - this.lastBeat >= 280 &&
        onset > Math.max(0.003, this.onsetAverage * (1.65 / Math.sqrt(this.sensitivity))) &&
        onset > this.previousOnset * 1.12
      this.onsetAverage += (onset - this.onsetAverage) * (1 - Math.exp(-elapsed / 600))
      this.previousOnset = onset
      if (beat) {
        this.phase = (this.phase + 1) % PALETTE.length
        this.lastBeat = now
      }
      // Preserve a short onset through the next available radio update.
      if (energy > this.envelope) this.envelope = energy
      else if (now - this.lastBeat >= 250)
        this.envelope += (energy - this.envelope) * (1 - Math.exp(-elapsed / 180))

      bands.forEach((value, index) => {
        if (value > this.bandEnvelope[index]!) this.bandEnvelope[index] = value
        else if (now - this.lastBeat >= 250)
          this.bandEnvelope[index]! += (value - this.bandEnvelope[index]!) * (1 - Math.exp(-elapsed / 180))
      })
      const strongestBand = Math.max(...this.bandEnvelope, 0.000001)
      const targets = [this.envelope * 3, ...this.bandEnvelope.map(value => value / strongestBand * this.envelope * 3)]
      targets.forEach((target, index) => {
        if (Math.abs(target - this.levels[index]!) > 0.65) this.levels[index] = Math.round(target)
      })
      if (now - this.lastFrame < 250) return
      this.lastFrame = now
      let colors: readonly [Rgb, Rgb]
      if (this.effect === 'cycle') {
        const scale = this.levels[0]! * 85
        const first = PALETTE[this.phase]!
        const second = PALETTE[(this.phase + 3) % PALETTE.length]!
        colors = [
          [first[0] * scale, first[1] * scale, first[2] * scale],
          [second[0] * scale, second[1] * scale, second[2] * scale],
        ]
      } else {
        const color: Rgb = [this.levels[1]! * 85, this.levels[2]! * 85, this.levels[3]! * 85]
        colors = [color, color]
      }
      onFrame({ colors })
    }
    this.animation = window.requestAnimationFrame(tick)
  }

  pause() {
    window.cancelAnimationFrame(this.animation)
    this.audio.pause()
  }

  seek(seconds: number) {
    this.audio.currentTime = seconds
    this.resetAnalysis()
  }

  setVolume(value: number) {
    this.volume = value
    if (this.gain) this.gain.gain.value = value
  }

  dispose() {
    this.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
    if (this.url) URL.revokeObjectURL(this.url)
    if (this.context) void this.context.close()
  }

  private resetAnalysis() {
    this.peak = 0.04
    this.envelope = 0
    this.bandEnvelope.fill(0)
    this.onsetAverage = 0
    this.previousOnset = 0
    this.lastBeat = -Infinity
    this.lastFrame = -Infinity
    this.phase = 5
    this.levels.fill(0)
  }
}
