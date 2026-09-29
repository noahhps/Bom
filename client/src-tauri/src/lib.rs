//! The desktop shell.
//!
//! Deliberately thin. Everything the app *does* still lives in the React
//! client and the Python server -- this crate owns only the things a webview
//! cannot do for itself: a menu bar presence, a window that hides instead of
//! quitting, and supervising the server process.
//!
//! Keeping it thin is what makes the Windows client cheap later: none of the
//! product logic is in here to be ported.

mod quickview;
mod server;

use tauri::{
    menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, RunEvent, WebviewWindow, WindowEvent,
};

use server::ManagedServer;

/// The kinds of conversation the File menu and the tray start -- a chat, a
/// code session, a design -- as (menu id, kind). Each opens the page's one
/// new-conversation screen with its composer set to that kind.
const NEW_KINDS: &[(&str, &str)] = &[("new-chat", "chat"), ("new-code", "code"), ("new-design", "design")];

/// The glass behind the rail.
#[cfg(target_os = "macos")]
fn apply_glass(window: &WebviewWindow) {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    // The webview paints its own opaque ground unless told not to.
    // `transparent: true` on the window is not enough on its own -- the
    // material ends up behind an opaque sheet of nothing.
    if let Err(err) = window.set_background_color(None) {
        eprintln!("[glass] could not clear the webview background: {err}");
    }
    // The same material QuickView uses, on purpose. `Sidebar` is the
    // semantically correct one for this region, but it is a paler, flatter
    // frost, and the rail is meant to look like the panel -- same glass, same
    // room.
    match apply_vibrancy(window, NSVisualEffectMaterial::HudWindow, Some(NSVisualEffectState::Active), None) {
        Ok(()) => println!("[glass] sidebar vibrancy applied to the main window"),
        // Reported, not swallowed. A silent failure here is indistinguishable
        // from a CSS problem, which is exactly the confusion this cost once.
        Err(err) => eprintln!("[glass] vibrancy refused: {err}"),
    }
    // The stylesheet keys the glass rail off `data-shell`, which the page sets
    // for itself. Set again from here so the styling does not depend on a
    // feature check in the page being right.
    let _ = window.eval("document.documentElement.setAttribute('data-shell','tauri')");
}

#[cfg(not(target_os = "macos"))]
fn apply_glass(_window: &WebviewWindow) {}

/// A new conversation picked from the File menu or the tray: the window
/// comes forward and the page starts one of that kind. False for any other
/// menu item.
fn new_menu_event(app: &AppHandle, id: &str) -> bool {
    let Some((_, kind)) = NEW_KINDS.iter().find(|(item, _)| *item == id) else {
        return false;
    };
    present_main_window(app);
    let _ = app.emit_to("main", "bom://new", *kind);
    true
}

/// Bring the window back to the front, un-hiding it first if the close button
/// put it away. Used by both the tray menu and a left-click on the icon.
fn present_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Where the windows were left, and how big. Position and size only:
        // the default set also restores *visibility*, which would put QuickView
        // back on screen at launch -- a panel that is supposed to arrive on a
        // keystroke greeting you at login instead.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE,
                )
                .build(),
        )
        .manage(ManagedServer::default())
        // New conversations, from the menu bar's File menu and from the tray
        // alike. Checked by id, so the tray's own items -- handled on the
        // tray -- pass straight through.
        .on_menu_event(|app, event| {
            new_menu_event(app, event.id().as_ref());
        })
        .setup(|app| {
            let handle = app.handle();

            // The material behind the glass rail. `Sidebar` is what the system
            // uses for this exact region, so the rail picks up the desktop the
            // way Finder's does. The sheet paints over it -- see the
            // `html[data-shell]` rules in styles.css, which pin the sheet's
            // tokens opaque so the translucency stops at the rail's edge.
            if let Some(main) = handle.get_webview_window("main") {
                apply_glass(&main);
            }

            // The menu bar: the system's standard menus, with a new chat, code
            // session and design at the head of File.
            #[cfg(target_os = "macos")]
            {
                let menu = Menu::default(handle)?;
                let chat_item = MenuItem::with_id(app, "new-chat", "New Chat", true, Some("CmdOrCtrl+1"))?;
                let code_item = MenuItem::with_id(app, "new-code", "New Code Session", true, Some("CmdOrCtrl+2"))?;
                let design_item = MenuItem::with_id(app, "new-design", "New Design", true, Some("CmdOrCtrl+3"))?;
                let separator = PredefinedMenuItem::separator(app)?;
                let mut placed = false;
                for item in menu.items()? {
                    if let MenuItemKind::Submenu(sub) = item {
                        if sub.text()? == "File" {
                            sub.insert_items(&[&chat_item, &code_item, &design_item, &separator], 0)?;
                            placed = true;
                        }
                    }
                }
                if !placed {
                    let sub = Submenu::with_items(app, "File", true, &[&chat_item, &code_item, &design_item])?;
                    menu.insert(&sub, 1)?;
                }
                app.set_menu(menu)?;
            }

            quickview::setup(handle);
            let bound = quickview::register(handle);

            let open = MenuItem::with_id(app, "open", "Open Bom", true, None::<&str>)?;
            // Named with the key it answers to, so the tray is where you find
            // out what the shortcut is. When registration failed there is no
            // key to name, and the item says so rather than lying.
            let quick = MenuItem::with_id(
                app,
                "quickview",
                &match &bound {
                    Some(spec) => format!("QuickView  ({spec})"),
                    None => "QuickView  (no shortcut)".to_string(),
                },
                true,
                None::<&str>,
            )?;
            let code = MenuItem::with_id(app, "new-code", "New Code Session", true, None::<&str>)?;
            let design = MenuItem::with_id(app, "new-design", "New Design", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Bom", true, Some("Cmd+Q"))?;
            let menu = Menu::with_items(app, &[&open, &quick, &code, &design, &quit])?;

            TrayIconBuilder::with_id("bom-tray")
                // The app icon, for now. Next event and reachability replace
                // this once there is a server to ask.
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                // macOS convention: the icon is a menu, not a button. Left
                // click opening the window instead would make the menu
                // reachable only by right-click, which nobody discovers.
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => present_main_window(app),
                    "quickview" => quickview::toggle(app),
                    "quit" => app.exit(0),
                    // New Code Session and New Design: handled by the
                    // app-wide listener above, which hears the tray's items
                    // as well.
                    _ => {}
                })
                .build(app)?;

            // The window is configured hidden and shown here, once the API is
            // answering. Booting it earlier means the client's first request
            // races a server that is still importing numpy, and loses -- which
            // reaches the reader as "that token was rejected" rather than as
            // "wait a moment".
            //
            // On its own thread because it blocks: `setup` runs before the
            // event loop, so waiting here would freeze the tray too.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let ready = server::ensure_running(&handle);
                if !ready {
                    // Shown anyway. The gate can explain an unreachable server
                    // and let the reader point somewhere else; a window that
                    // never appears cannot.
                    eprintln!("[server] opening the window without a local server");
                }
                present_main_window(&handle);
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // The close button hides rather than quits. An assistant that is
            // supposed to be always available should not need relaunching
            // because the window was in the way -- and quitting now also stops
            // the server, which is a much bigger deal than closing a window
            // looks.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }

            // Fullscreen turns the glass rail off.
            //
            // Translucency only means anything when there is something behind
            // the window. Fullscreen covers the desktop entirely, so the
            // material has nothing left to sample and returns a flat cast --
            // which is why a green accent came out with a blue sidebar. The
            // page cannot see this for itself: macOS fullscreen is a window
            // state, not a viewport one, and there is no media query for it.
            //
            // Resized is what fires on the transition in both directions.
            if let WindowEvent::Resized(_) = event {
                if window.label() == "main" {
                    let full = window.is_fullscreen().unwrap_or(false);
                    // `eval` is on the webview, and this handler is handed the
                    // window it sits in -- so the webview is fetched back off
                    // the app handle rather than assumed.
                    if let Some(view) = window.app_handle().get_webview_window("main") {
                        let _ = view.eval(&format!(
                            "document.documentElement.toggleAttribute('data-fullscreen', {full})"
                        ));
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Bom");

    app.run(|handle, event| {
        // Exit is the one place the server can be stopped from: window close
        // is a hide, and the tray's Quit routes here too.
        if let RunEvent::Exit = event {
            server::shutdown(handle);
        }
    });
}
