use crate::model::Event;
use ipnet::IpNet;
use serde::Deserialize;
use std::net::IpAddr;

#[derive(Deserialize, Default)]
pub struct Exclusions {
    pub networks: Vec<IpNet>,
    profiles: Vec<String>,
    rules: Vec<Rule>,
}
#[derive(Deserialize)]
struct Rule {
    event: String,
    property: String,
    op: String,
    value: serde_json::Value,
}
impl Exclusions {
    pub fn network(&self, ip: Option<IpAddr>) -> bool {
        ip.is_some_and(|ip| self.networks.iter().any(|net| net.contains(&ip)))
    }
    pub fn matches(&self, e: &Event) -> bool {
        e.profile_id
            .as_ref()
            .is_some_and(|id| self.profiles.contains(id))
            || self.rules.iter().any(|r| {
                if !r.event.is_empty() && r.event != e.name {
                    return false;
                }
                if r.property.is_empty() {
                    return true;
                }
                let Some(v) = e.properties.get(&r.property) else {
                    return false;
                };
                if r.op == "eq" {
                    return v == &r.value;
                }
                let (Some(text), Some(needle)) = (v.as_str(), r.value.as_str()) else {
                    return false;
                };
                match r.op.as_str() {
                    "contains" => text.to_lowercase().contains(&needle.to_lowercase()),
                    "starts_with" => text.starts_with(needle),
                    "ends_with" => text.ends_with(needle),
                    _ => false,
                }
            })
    }
}
