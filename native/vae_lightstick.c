#include <furi.h>
#include <furi_hal.h>
#include <furi_hal_subghz.h>
#include <cli/cli.h>
#include <gui/gui.h>
#include <input/input.h>
#include <toolbox/args.h>
#include <toolbox/level_duration.h>
#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#define VAE_FREQUENCY 433920000U
#define VAE_PROTOCOL_VERSION 2
#define VAE_RUN_CAPACITY 262
#define VAE_HIGH 0x80000000U

// Same radio registers as the project's Python/TS generators; PA[1] is always 07.
// Configuration sources and protocol attribution are documented in README.md.
static const uint8_t vae_preset[] = {
    0x02, 0x0D, 0x03, 0x07, 0x08, 0x32, 0x0B, 0x06, 0x14, 0x00, 0x13, 0x00,
    0x12, 0x30, 0x11, 0x32, 0x10, 0x17, 0x18, 0x18, 0x19, 0x18, 0x1D, 0x91,
    0x1C, 0x00, 0x1B, 0x07, 0x20, 0xFB, 0x22, 0x11, 0x21, 0xB6, 0x00, 0x00,
    0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

typedef struct {
    uint32_t runs[VAE_RUN_CAPACITY];
    size_t count;
    size_t index;
    uint32_t remaining;
} VaeTx;

typedef enum { VaeIdle, VaeTimer, VaeEffect } VaeMode;

static const uint8_t vae_targets[] = {0xC0, 0xFF, 1, 2, 4, 8, 16, 32, 64, 128};
static const uint16_t vae_delays[] = {0, 2, 10, 30, 60};
static const uint16_t vae_speeds[] = {500, 1000, 2000};
static const uint8_t vae_loops[] = {1, 3, 5, 10, 0};
static const char* const vae_effect_names[] = {"Static", "Red/blue", "RGBW", "Blink"};

typedef struct {
    FuriMutex* mutex;
    FuriMessageQueue* input;
    VaeTx tx;
    bool running;
    bool last_ok;
    uint32_t last_ms;
    uint32_t updates;
    uint8_t colors[8];
    uint8_t draft[8];
    uint8_t after[8];
    uint8_t effect_base[8];
    VaeMode mode;
    uint32_t next_at;
    uint8_t effect;
    uint8_t effect_mask;
    uint16_t effect_interval;
    uint32_t effect_step;
    uint32_t effect_total;
    uint8_t row;
    uint8_t target;
    uint8_t delay;
    uint8_t local_effect;
    uint8_t speed;
    uint8_t loops;
} VaeApp;

static uint8_t vae_checksum(const uint8_t* data, size_t count) {
    uint8_t value = 0x0D;
    for(size_t i = 0; i < count; i++) value ^= (data[i] >> 4) ^ (data[i] & 0x0F);
    return 0x80 | value;
}

static void vae_append(VaeTx* tx, bool high, uint32_t duration) {
    uint32_t level = high ? VAE_HIGH : 0;
    if(tx->count && (tx->runs[tx->count - 1] & VAE_HIGH) == level) {
        tx->runs[tx->count - 1] += duration;
    } else {
        tx->runs[tx->count++] = level | duration;
    }
}

static void vae_bytes(VaeTx* tx, const uint8_t* data, size_t count) {
    for(size_t i = 0; i < count; i++) {
        for(uint8_t mask = 0x80; mask; mask >>= 1) {
            bool bit = (data[i] & mask) != 0;
            vae_append(tx, !bit, 250);
            vae_append(tx, bit, 250);
        }
    }
}

static void vae_frame(VaeTx* tx, const uint8_t colors[8], bool legacy, uint32_t frames) {
    uint8_t packet[16] = {0};
    memcpy(packet, colors, 7);
    packet[10] = vae_checksum(packet, 10);
    size_t count = legacy ? 13 : 16;
    if(!legacy) {
        packet[11] = colors[7];
        packet[12] = vae_checksum(packet, 12);
        packet[13] = 0x03;
        packet[14] = 0x03;
        packet[15] = vae_checksum(packet, 15);
    }
    tx->count = 0;
    tx->index = 0;
    tx->remaining = frames;
    vae_bytes(tx, packet + count - 2, 2);
    vae_append(tx, false, legacy ? 500 : 1000);
    vae_append(tx, true, 250);
    vae_append(tx, false, 250);
    vae_bytes(tx, packet, count - 2);
    if(legacy) vae_append(tx, false, 50000);
}

static LevelDuration vae_yield(void* context) {
    VaeTx* tx = context;
    if(!tx->remaining) return level_duration_reset();
    uint32_t run = tx->runs[tx->index++];
    if(tx->index == tx->count) {
        tx->index = 0;
        tx->remaining--;
    }
    return level_duration_make((run & VAE_HIGH) != 0, run & ~VAE_HIGH);
}

static bool vae_transmit(VaeApp* app, const uint8_t colors[8], uint32_t frames, bool legacy) {
    uint32_t started = furi_get_tick();
    vae_frame(&app->tx, colors, legacy, frames);
    furi_hal_power_suppress_charge_enter();
    bool ok = furi_hal_subghz_tx();
    if(ok) {
        ok = furi_hal_subghz_start_async_tx(vae_yield, &app->tx);
        if(ok) {
            while(!furi_hal_subghz_is_async_tx_complete()) furi_delay_ms(1);
            furi_hal_subghz_stop_async_tx();
        }
    }
    furi_hal_subghz_idle();
    furi_hal_power_suppress_charge_exit();
    if(ok && !legacy) memcpy(app->colors, colors, 8);
    app->last_ok = ok;
    app->last_ms = (furi_get_tick() - started) * 1000 / furi_kernel_get_tick_frequency();
    app->updates++;
    return ok;
}

static bool vae_off(VaeApp* app) {
    app->mode = VaeIdle;
    static const uint8_t off[8] = {3, 3, 3, 3, 3, 3, 3, 3};
    bool full = vae_transmit(app, off, 16, false);
    bool legacy = vae_transmit(app, off, 8, true);
    return full && legacy;
}

static bool vae_stop(VaeApp* app) {
    bool active = app->mode != VaeIdle;
    app->mode = VaeIdle;
    return !active || vae_transmit(app, app->after, 16, false);
}

static bool vae_apply(
    VaeApp* app, const uint8_t colors[8], const uint8_t after[8], uint32_t seconds) {
    app->mode = VaeIdle;
    bool ok = vae_transmit(app, colors, 3, false);
    if(ok && seconds) {
        memcpy(app->after, after, 8);
        app->next_at = furi_get_tick() + furi_ms_to_ticks(seconds * 1000);
        app->mode = VaeTimer;
    }
    return ok;
}

static bool vae_effect_step(VaeApp* app) {
    static const uint8_t cycle[] = {0x0F, 0x33, 0xC3, 0xFF};
    uint8_t colors[8];
    memcpy(colors, app->effect_base, 8);
    uint8_t selected = 0;
    for(size_t i = 0; i < 8; i++) {
        if(!(app->effect_mask & (1U << i))) continue;
        if(app->effect == 1) colors[i] = ((app->effect_step + selected++) & 1) ? 0xC3 : 0x0F;
        else if(app->effect == 2) colors[i] = cycle[app->effect_step % 4];
        else if(app->effect_step & 1) colors[i] = 3;
    }
    app->next_at = furi_get_tick() + furi_ms_to_ticks(app->effect_interval);
    bool ok = vae_transmit(app, colors, 3, false);
    app->effect_step++;
    if(!ok) app->mode = VaeIdle;
    return ok;
}

static bool vae_play(
    VaeApp* app, uint8_t effect, uint8_t mask, const uint8_t colors[8],
    uint16_t interval, uint8_t loops) {
    app->mode = VaeEffect;
    app->effect = effect;
    app->effect_mask = mask;
    app->effect_interval = interval;
    app->effect_step = 0;
    app->effect_total = loops * (effect == 2 ? 4 : 2);
    memcpy(app->effect_base, colors, 8);
    memcpy(app->after, colors, 8);
    for(size_t i = 0; i < 8; i++) {
        if(mask & (1U << i)) app->after[i] = 3;
    }
    return vae_effect_step(app);
}

static uint32_t vae_remaining(VaeApp* app) {
    int32_t ticks = (int32_t)(app->next_at - furi_get_tick());
    return app->mode == VaeTimer && ticks > 0 ?
               (uint32_t)ticks * 1000 / furi_kernel_get_tick_frequency() : 0;
}

static void vae_state(VaeApp* app) {
    printf("VAE:STATE ");
    for(size_t i = 0; i < 8; i++) printf("%02x", app->colors[i]);
    printf(" MODE=%u LEFT=%lu EFFECT=%u STEP=%lu TOTAL=%lu OK=%u\r\n",
           (unsigned)app->mode, (unsigned long)vae_remaining(app), app->effect,
           (unsigned long)app->effect_step, (unsigned long)app->effect_total,
           app->last_ok ? 1 : 0);
}

// Validate the external color representation once, at the CLI boundary.
static bool vae_parse_colors(const char* text, uint8_t colors[8]) {
    if(strlen(text) != 16) return false;
    for(size_t i = 0; i < 16; i++) {
        if(!isxdigit((unsigned char)text[i])) return false;
    }
    for(size_t i = 0; i < 8; i++) {
        char pair[3] = {text[i * 2], text[i * 2 + 1], 0};
        colors[i] = (uint8_t)strtoul(pair, NULL, 16);
        if((colors[i] & 3) != 3) return false;
    }
    return true;
}

static bool vae_read_number(
    FuriString* args, FuriString* word, uint32_t* result, uint32_t min, uint32_t max) {
    if(!args_read_string_and_trim(args, word)) return false;
    const char* text = furi_string_get_cstr(word);
    size_t length = strlen(text);
    if(!length || length > 7 || strspn(text, "0123456789") != length) return false;
    *result = strtoul(text, NULL, 10);
    return *result >= min && *result <= max;
}

static void vae_cli(PipeSide* pipe, FuriString* args, void* context) {
    UNUSED(pipe);
    VaeApp* app = context;
    FuriString* command = furi_string_alloc();
    FuriString* value = furi_string_alloc();
    uint8_t colors[8];
    uint8_t after[8];
    uint32_t seconds = 0, effect = 0, mask = 0, interval = 0, loops = 0;
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    do {
        if(!app->running) {
            printf("VAE:ERROR closing\r\n");
            break;
        }
        if(!args_read_string_and_trim(args, command)) {
            printf("VAE:ERROR expected info/state/live/hold/auto/effect/stop/off/exit\r\n");
            break;
        }
        bool info = furi_string_equal(command, "info");
        bool exit = furi_string_equal(command, "exit");
        bool off = furi_string_equal(command, "off");
        bool live = furi_string_equal(command, "live");
        bool hold = furi_string_equal(command, "hold");
        bool automatic = furi_string_equal(command, "auto");
        bool state = furi_string_equal(command, "state");
        bool play = furi_string_equal(command, "effect");
        bool stop = furi_string_equal(command, "stop");
        if(!(info || state || exit || off || live || hold || automatic || play || stop)) {
            printf("VAE:ERROR unknown command\r\n");
            break;
        }
        if(play && (!vae_read_number(args, value, &effect, 1, 3) ||
                    !vae_read_number(args, value, &mask, 1, 255))) {
            printf("VAE:ERROR expected effect 1..3 and group mask 1..255\r\n");
            break;
        }
        if(live || hold || automatic || play) {
            if(!args_read_string_and_trim(args, value) ||
               !vae_parse_colors(furi_string_get_cstr(value), colors)) {
                printf("VAE:ERROR expected 8 encoded colors (16 hex digits, low bits 11)\r\n");
                break;
            }
        }
        if(automatic && (!args_read_string_and_trim(args, value) ||
                         !vae_parse_colors(furi_string_get_cstr(value), after) ||
                         !vae_read_number(args, value, &seconds, 1, 3600))) {
            printf("VAE:ERROR expected 8 after-colors and delay 1..3600 seconds\r\n");
            break;
        }
        if(play && (!vae_read_number(args, value, &interval, 500, 10000) ||
                    !vae_read_number(args, value, &loops, 0, 99))) {
            printf("VAE:ERROR expected interval 500..10000 ms and loops 0..99\r\n");
            break;
        }
        if(!furi_string_empty(args)) {
            printf("VAE:ERROR extra arguments\r\n");
            break;
        }
        if(info) {
            printf("VAE:NATIVE %u PA=07 FREQ=%lu LIVE=3\r\n", VAE_PROTOCOL_VERSION,
                   (unsigned long)VAE_FREQUENCY);
            break;
        }
        if(state) {
            vae_state(app);
            break;
        }
        if(exit) {
            vae_stop(app);
            app->running = false;
            printf("VAE:BYE\r\n");
            break;
        }
        uint32_t started = furi_get_tick();
        bool ok;
        if(off) {
            ok = vae_off(app);
        } else if(stop) {
            ok = vae_stop(app);
        } else if(play) {
            ok = vae_play(app, effect, mask, colors, interval, loops);
        } else {
            ok = vae_apply(app, colors, after, seconds);
        }
        app->last_ok = ok;
        printf(ok ? "VAE:OK %lu\r\n" : "VAE:ERROR radio TX failed (%lu ms)\r\n",
               (unsigned long)((furi_get_tick() - started) * 1000 / furi_kernel_get_tick_frequency()));
        vae_state(app);
    } while(false);
    furi_string_free(command);
    furi_string_free(value);
    furi_mutex_release(app->mutex);
}

static void vae_draw(Canvas* canvas, void* context) {
    VaeApp* app = context;
    canvas_clear(canvas);
    canvas_set_font(canvas, FontSecondary);
    if(furi_mutex_acquire(app->mutex, 0) == FuriStatusOk) {
        char line[48];
        if(!app->last_ok) snprintf(line, sizeof(line), "VAE | TX error");
        else if(app->mode == VaeTimer)
            snprintf(line, sizeof(line), "VAE | OFF in %lus", (unsigned long)((vae_remaining(app) + 999) / 1000));
        else if(app->mode == VaeEffect)
            snprintf(line, sizeof(line), "VAE | %s playing", vae_effect_names[app->effect]);
        else snprintf(line, sizeof(line), "VAE | ready");
        canvas_draw_str(canvas, 2, 9, line);
        uint8_t mask = vae_targets[app->target];
        size_t first = 0;
        while(!(mask & (1U << first))) first++;
        uint8_t top = app->row < 4 ? 0 : 4;
        for(uint8_t row = top; row < top + 4; row++) {
            char value[32];
            if(row == 0) {
                if(app->target < 2) snprintf(value, sizeof(value), "Group: %s", app->target ? "All" : "G7+G8");
                else snprintf(value, sizeof(value), "Group: G%u", app->target - 1);
            } else if(row < 4) {
                snprintf(value, sizeof(value), "%s: %u / 3", row == 1 ? "Red" : row == 2 ? "Green" : "Blue",
                         (app->draft[first] >> (row * 2)) & 3);
            } else if(row == 4) {
                if(app->delay) snprintf(value, sizeof(value), "Auto off: %us", vae_delays[app->delay]);
                else snprintf(value, sizeof(value), "Auto off: disabled");
            } else if(row == 5) snprintf(value, sizeof(value), "Effect: %s", vae_effect_names[app->local_effect]);
            else if(row == 6) snprintf(value, sizeof(value), "Step: %u ms", vae_speeds[app->speed]);
            else if(vae_loops[app->loops]) snprintf(value, sizeof(value), "Loops: %u", vae_loops[app->loops]);
            else snprintf(value, sizeof(value), "Loops: continuous");
            snprintf(line, sizeof(line), "%c %s", row == app->row ? '>' : ' ', value);
            canvas_draw_str(canvas, 2, 21 + (row - top) * 10, line);
        }
        furi_mutex_release(app->mutex);
    } else {
        canvas_draw_str(canvas, 3, 28, "Sending...");
    }
    canvas_draw_str(canvas, 2, 63, "OK send | Hold OK: OFF");
}

static void vae_input(InputEvent* event, void* context) {
    VaeApp* app = context;
    if(event->type == InputTypeShort || event->type == InputTypeLong || event->type == InputTypeRepeat)
        furi_message_queue_put(app->input, event, 0);
}

int32_t vae_lightstick_app(void* context) {
    UNUSED(context);
    VaeApp* app = malloc(sizeof(VaeApp));
    memset(app, 0, sizeof(VaeApp));
    app->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    app->input = furi_message_queue_alloc(8, sizeof(InputEvent));
    app->running = true;
    app->last_ok = true;
    memset(app->colors, 3, 8);
    memset(app->draft, 3, 8);
    app->draft[6] = app->draft[7] = 0x1F;
    app->delay = 1;
    app->speed = 1;
    app->loops = 2;

    furi_hal_power_insomnia_enter();
    furi_hal_subghz_reset();
    furi_hal_subghz_idle();
    furi_hal_subghz_load_custom_preset(vae_preset);
    furi_hal_subghz_set_frequency_and_path(VAE_FREQUENCY);

    Gui* gui = furi_record_open(RECORD_GUI);
    ViewPort* view = view_port_alloc();
    view_port_draw_callback_set(view, vae_draw, app);
    view_port_input_callback_set(view, vae_input, app);
    gui_add_view_port(gui, view, GuiLayerFullscreen);
    CliRegistry* cli = furi_record_open(RECORD_CLI);
    cli_registry_add_command_ex(cli, "vae", CliCommandFlagParallelSafe, vae_cli, app, 3072);

    while(true) {
        InputEvent event;
        bool input = furi_message_queue_get(app->input, &event, 20) == FuriStatusOk;
        furi_mutex_acquire(app->mutex, FuriWaitForever);
        if(input) {
            if(event.key == InputKeyBack && event.type == InputTypeShort) {
                if(app->mode != VaeIdle) vae_stop(app);
                else app->running = false;
            } else if(event.key == InputKeyOk && event.type == InputTypeLong) {
                app->last_ok = vae_off(app);
            } else if(event.key == InputKeyOk && event.type == InputTypeShort) {
                uint8_t mask = vae_targets[app->target];
                uint8_t colors[8], after[8];
                for(size_t i = 0; i < 8; i++) {
                    colors[i] = mask & (1U << i) ? app->draft[i] : app->colors[i];
                    after[i] = mask & (1U << i) ? 3 : colors[i];
                }
                if(app->local_effect)
                    vae_play(app, app->local_effect, mask, colors, vae_speeds[app->speed], vae_loops[app->loops]);
                else vae_apply(app, colors, after, vae_delays[app->delay]);
            } else if(event.type == InputTypeShort || event.type == InputTypeRepeat) {
                int delta = event.key == InputKeyLeft ? -1 : 1;
                if(event.key == InputKeyUp) app->row = (app->row + 7) % 8;
                else if(event.key == InputKeyDown) app->row = (app->row + 1) % 8;
                else if(event.key == InputKeyLeft || event.key == InputKeyRight) {
                    if(app->row == 0) app->target = (app->target + delta + 10) % 10;
                    else if(app->row < 4) {
                        uint8_t mask = vae_targets[app->target];
                        size_t first = 0;
                        while(!(mask & (1U << first))) first++;
                        uint8_t shift = app->row * 2;
                        uint8_t level = (((app->draft[first] >> shift) & 3) + delta + 4) % 4;
                        for(size_t i = 0; i < 8; i++) {
                            if(mask & (1U << i)) app->draft[i] = (app->draft[i] & ~(3U << shift)) | (level << shift);
                        }
                    } else if(app->row == 4) app->delay = (app->delay + delta + 5) % 5;
                    else if(app->row == 5) app->local_effect = (app->local_effect + delta + 4) % 4;
                    else if(app->row == 6) app->speed = (app->speed + delta + 3) % 3;
                    else app->loops = (app->loops + delta + 5) % 5;
                }
            }
        }
        if(app->running && app->mode != VaeIdle && (int32_t)(furi_get_tick() - app->next_at) >= 0) {
            if(app->mode == VaeTimer || (app->effect_total && app->effect_step >= app->effect_total))
                vae_stop(app);
            else vae_effect_step(app);
        }
        bool running = app->running;
        furi_mutex_release(app->mutex);
        if(!running) break;
        view_port_update(view);
    }

    cli_registry_delete_command(cli, "vae");
    furi_record_close(RECORD_CLI);
    furi_hal_subghz_idle();
    furi_hal_subghz_sleep();
    furi_hal_power_insomnia_exit();
    gui_remove_view_port(gui, view);
    view_port_free(view);
    furi_record_close(RECORD_GUI);
    furi_message_queue_free(app->input);
    furi_mutex_free(app->mutex);
    free(app);
    return 0;
}
