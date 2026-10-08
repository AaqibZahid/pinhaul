//! Pinpull's modules.
//!
//! The binary sits in `main.rs`; this target exists so integration tests can
//! drive the same modules the binary uses, against a fixture server rather
//! than live Pinterest.

pub mod auth;
pub mod board;
pub mod cli;
pub mod download;
pub mod error;
pub mod hls;
pub mod input;
pub mod media;
pub mod pinterest;
pub mod state;
