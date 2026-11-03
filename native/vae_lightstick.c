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
#define VAE_PROTOCOL_VERSION 1
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

typedef struct {
    FuriMutex* mutex;
    FuriMessageQueue* input;
    VaeTx tx;
    bool running;
    bool last_ok;
    uint32_t last_ms;
    uint32_t updates;
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
    return ok;
}

static bool vae_off(VaeApp* app) {
    static const uint8_t off[8] = {3, 3, 3, 3, 3, 3, 3, 3};
    bool full = vae_transmit(app, off, 16, false);
    bool legacy = vae_transmit(app, off, 8, true);
    return full && legacy;
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

static void vae_cli(PipeSide* pipe, FuriString* args, void* context) {
    UNUSED(pipe);
    VaeApp* app = context;
    FuriString* command = furi_string_alloc();
    FuriString* value = furi_string_alloc();
    uint8_t colors[8];
    uint8_t after[8];
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    do {
        if(!app->running) {
            printf("VAE:ERROR closing\r\n");
            break;
        }
        if(!args_read_string_and_trim(args, command)) {
            printf("VAE:ERROR expected info/live/hold/auto/off/exit\r\n");
            break;
        }
        bool info = furi_string_equal(command, "info");
        bool exit = furi_string_equal(command, "exit");
        bool off = furi_string_equal(command, "off");
        bool live = furi_string_equal(command, "live");
        bool hold = furi_string_equal(command, "hold");
        bool automatic = furi_string_equal(command, "auto");
        if(!(info || exit || off || live || hold || automatic)) {
            printf("VAE:ERROR unknown command\r\n");
            break;
        }
        if(live || hold || automatic) {
            if(!args_read_string_and_trim(args, value) ||
               !vae_parse_colors(furi_string_get_cstr(value), colors)) {
                printf("VAE:ERROR expected 8 encoded colors (16 hex digits, low bits 11)\r\n");
                break;
            }
        }
        if(automatic && (!args_read_string_and_trim(args, value) ||
                         !vae_parse_colors(furi_string_get_cstr(value), after))) {
            printf("VAE:ERROR expected 8 after-colors\r\n");
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
        if(exit) {
            app->running = false;
            printf("VAE:BYE\r\n");
            break;
        }
        uint32_t started = furi_get_tick();
        bool ok;
        if(off) {
            ok = vae_off(app);
        } else {
            ok = vae_transmit(app, colors, live ? 3 : 32, false);
            if(ok && automatic) ok = vae_transmit(app, after, 16, false);
        }
        app->last_ms = (furi_get_tick() - started) * 1000 / furi_kernel_get_tick_frequency();
        app->last_ok = ok;
        app->updates++;
        printf(ok ? "VAE:OK %lu\r\n" : "VAE:ERROR radio TX failed (%lu ms)\r\n",
               (unsigned long)app->last_ms);
    } while(false);
    furi_string_free(command);
    furi_string_free(value);
    furi_mutex_release(app->mutex);
}

static void vae_draw(Canvas* canvas, void* context) {
    VaeApp* app = context;
    canvas_clear(canvas);
    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str(canvas, 3, 12, "VAE Lightstick");
    canvas_set_font(canvas, FontSecondary);
    canvas_draw_str(canvas, 3, 25, "433.92 MHz | PA 07 fixed");
    if(furi_mutex_acquire(app->mutex, 0) == FuriStatusOk) {
        char line[48];
        snprintf(line, sizeof(line), "USB ready | updates %lu", (unsigned long)app->updates);
        canvas_draw_str(canvas, 3, 37, line);
        snprintf(line, sizeof(line), "Last: %lu ms %s", (unsigned long)app->last_ms,
                 app->updates ? (app->last_ok ? "OK" : "ERROR") : "");
        canvas_draw_str(canvas, 3, 48, line);
        furi_mutex_release(app->mutex);
    } else {
        canvas_draw_str(canvas, 3, 39, "Sending...");
    }
    canvas_draw_str(canvas, 3, 62, "OK: all OFF   Back: exit");
}

static void vae_input(InputEvent* event, void* context) {
    VaeApp* app = context;
    if(event->type == InputTypeShort) furi_message_queue_put(app->input, event, 0);
}

int32_t vae_lightstick_app(void* context) {
    UNUSED(context);
    VaeApp* app = malloc(sizeof(VaeApp));
    memset(app, 0, sizeof(VaeApp));
    app->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    app->input = furi_message_queue_alloc(8, sizeof(InputEvent));
    app->running = true;

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
        bool input = furi_message_queue_get(app->input, &event, 50) == FuriStatusOk;
        furi_mutex_acquire(app->mutex, FuriWaitForever);
        if(input && event.key == InputKeyBack) app->running = false;
        if(input && event.key == InputKeyOk) {
            uint32_t started = furi_get_tick();
            app->last_ok = vae_off(app);
            app->last_ms = (furi_get_tick() - started) * 1000 / furi_kernel_get_tick_frequency();
            app->updates++;
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
