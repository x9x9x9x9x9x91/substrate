//! iOS WidgetKit bridge.
//!
//! The extension never opens the vault or embeds the Rust engine. The React
//! app evaluates dashboard cards, this module validates/serializes that small
//! read model, and a Swift bridge atomically replaces it in the App Group.
//!
//! Export is allow-listed by placement: the app first asks WidgetKit which
//! card ids the widgets on the home screen are configured for
//! (`widget_configured_ids`), and only those cards' rendered values are ever
//! written. The summary's `index` half carries labels alone — the widget
//! gallery's picker needs names, never numbers.

#[cfg(target_os = "ios")]
use std::ffi::CString;
#[cfg(target_os = "ios")]
use std::os::raw::c_char;

#[cfg(target_os = "ios")]
fn bridge_symbol(name: &std::ffi::CStr) -> Option<*mut libc::c_void> {
    // Cargo first links this crate as an iOS cdylib, before Xcode links the
    // containing app's Swift sources. A normal extern reference is therefore
    // unresolved too early. Look it up only at runtime; the Xcode target
    // force-retains the @_cdecl bridge functions in the final app.
    let raw = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    (!raw.is_null()).then_some(raw)
}

pub(crate) fn summary_supported() -> bool {
    cfg!(target_os = "ios")
}

/// Card ids referenced by widgets currently placed on the home screen. The
/// answer is WidgetKit's, not a cache: remove the last widget and the next
/// refresh exports nothing.
pub(crate) fn configured_ids() -> Result<Vec<String>, String> {
    #[cfg(target_os = "ios")]
    {
        let raw = bridge_symbol(c"substrate_widget_configured_ids")
            .ok_or("WidgetKit bridge is unavailable")?;
        let read: unsafe extern "C" fn() -> *mut c_char = unsafe { std::mem::transmute(raw) };
        let ptr = unsafe { read() };
        if ptr.is_null() {
            return Err("could not read the home screen's widget configurations".into());
        }
        // SAFETY: Swift returns a strdup'd NUL-terminated UTF-8 JSON array;
        // ownership transfers here, so the copy is followed by libc::free.
        let json = unsafe { std::ffi::CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
        unsafe { libc::free(ptr.cast()) };
        serde_json::from_str::<Vec<String>>(&json)
            .map_err(|e| format!("widget configuration list was not a string array: {e}"))
    }
    #[cfg(not(target_os = "ios"))]
    Ok(Vec::new())
}

pub(crate) fn write_summary(summary: serde_json::Value) -> Result<(), String> {
    if summary.get("schema").and_then(serde_json::Value::as_u64) != Some(2) {
        return Err("unsupported widget summary schema".into());
    }
    if !summary.get("index").is_some_and(serde_json::Value::is_array) {
        return Err("widget summary index must be an array".into());
    }
    if !summary.get("cards").is_some_and(serde_json::Value::is_array) {
        return Err("widget summary cards must be an array".into());
    }

    #[cfg(target_os = "ios")]
    {
        let json = serde_json::to_string(&summary).map_err(|e| e.to_string())?;
        let json = CString::new(json).map_err(|_| "widget summary contains a NUL byte")?;
        let raw = bridge_symbol(c"substrate_widget_summary_write")
            .ok_or("WidgetKit bridge is unavailable")?;
        let write: unsafe extern "C" fn(*const c_char) -> bool =
            unsafe { std::mem::transmute(raw) };
        // SAFETY: Swift copies the NUL-terminated UTF-8 string synchronously
        // and returns before `json` is dropped.
        if !unsafe { write(json.as_ptr()) } {
            return Err("could not write the WidgetKit App Group summary".into());
        }
    }

    #[cfg(not(target_os = "ios"))]
    let _ = summary;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_write_requires_the_two_part_schema() {
        let ok = serde_json::json!({ "schema": 2, "index": [], "cards": [] });
        assert!(write_summary(ok).is_ok());
        for bad in [
            serde_json::json!({ "schema": 1, "cards": [] }),
            serde_json::json!({ "schema": 2, "cards": [] }),
            serde_json::json!({ "schema": 2, "index": [], "cards": {} }),
        ] {
            assert!(write_summary(bad).is_err());
        }
    }

    #[test]
    fn desktop_reports_no_configured_widgets() {
        assert_eq!(configured_ids().unwrap(), Vec::<String>::new());
    }
}
