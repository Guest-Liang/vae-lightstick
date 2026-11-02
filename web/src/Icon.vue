<script setup lang="ts">
defineProps<{ name: keyof typeof paths }>()

const paths = {
  usb: 'M12 21V4m0 0L9 7m3-3 3 3M12 16H8a3 3 0 0 1-3-3v-2m7 1h4a3 3 0 0 0 3-3V6M3.5 11h3M17.5 3.5h3v3h-3z',
  power: 'M12 3v8m-5.7-6a9 9 0 1 0 11.4 0',
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  chevron: 'm6 9 6 6 6-6',
  check: 'm5 12 4 4L19 6',
  disconnect: 'M9 3v4m6-4v4M7 7h10v3a5 5 0 0 1-10 0V7Zm5 8v6',
  sparkle: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  external:
    'M14 4h6v6m0-6L10 14m0-10H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
  info: 'M12 11v6m0-10h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
}
</script>

<template>
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="paths[name]" />
  </svg>
</template>
