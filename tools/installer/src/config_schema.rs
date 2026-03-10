//! Config schema parser — converts the JSON schema (config-schema.json)
//! into structured interview prompts for the TUI.
//!
//! This module will be implemented in Task 10.

use anyhow::Result;

/// Parsed representation of config-schema.json
#[derive(Debug, Clone, Default)]
pub struct ConfigSchema {
    pub sections: Vec<SchemaSection>,
}

/// A section in the config schema (e.g. "secrets", "features")
#[derive(Debug, Clone)]
pub struct SchemaSection {
    pub id: String,
    pub title: String,
    pub fields: Vec<SchemaField>,
}

/// A single field/prompt in the schema
#[derive(Debug, Clone)]
pub struct SchemaField {
    pub key: String,
    pub description: String,
    pub required: bool,
    pub secret: bool,
    pub default: Option<String>,
}

/// Parse a config schema from JSON string.
pub fn parse_schema(_json: &str) -> Result<ConfigSchema> {
    todo!("config_schema::parse_schema")
}
