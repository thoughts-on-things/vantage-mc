//! Line-delimited protocol shared with the Zig `vantage-core` sidecar.
//!
//! The sidecar interleaves human CLI diagnostics with prefixed records on
//! stderr; only prefixed lines are part of the desktop contract, so both
//! sides can evolve their plain output independently.

use serde::Deserialize;

pub const WORLD_PREFIX: &str = "VANTAGE_WORLD ";
pub const PROGRESS_PREFIX: &str = "VANTAGE_PROGRESS ";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreProgress {
    pub phase: String,
    pub completed: usize,
    pub total: usize,
}

/// Consumes every complete line in `buffer` (stderr arrives in arbitrary
/// chunks) and invokes `emit` for each valid progress record.
pub fn drain_progress(buffer: &mut String, mut emit: impl FnMut(CoreProgress)) {
    while let Some(newline) = buffer.find('\n') {
        let line = buffer[..newline].trim_end_matches('\r').to_string();
        buffer.drain(..=newline);
        let Some(json) = line.strip_prefix(PROGRESS_PREFIX) else {
            continue;
        };
        if let Ok(progress) = serde_json::from_str::<CoreProgress>(json) {
            emit(progress);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_records_survive_chunked_stderr() {
        let mut buffer = String::new();
        let mut phases = Vec::new();

        buffer.push_str("VANTAGE_PROGRESS {\"phase\":\"scanning\",\"completed\":0,");
        drain_progress(&mut buffer, |progress| phases.push(progress.phase));
        assert!(phases.is_empty(), "half a line must not emit");

        buffer.push_str("\"total\":4}\r\nplain diagnostic line\nVANTAGE_PROGRESS {\"phase\":\"tiles\",\"completed\":2,\"total\":4}\n");
        drain_progress(&mut buffer, |progress| phases.push(progress.phase));
        assert_eq!(phases, ["scanning", "tiles"]);
        assert!(buffer.is_empty());
    }
}
