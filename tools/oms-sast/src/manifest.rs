use crate::{Analysis, Hit, Location};

/// Inspect the supplied manifest only; Cargo configuration and environment are not resolved.
pub fn analyze(path: &str, source: &str) -> Result<Analysis, String> {
    let document: toml::Value = toml::from_str(source).map_err(|_| "invalid Cargo manifest TOML")?;
    let profile = document.get("profile").map(|value| value.as_table().ok_or("profile must be a table")).transpose()?;
    let release = profile.and_then(|profiles| profiles.get("release"))
        .map(|value| value.as_table().ok_or("profile.release must be a table")).transpose()?;
    let checks = release.and_then(|release| release.get("overflow-checks"))
        .map(|value| value.as_bool().ok_or("release overflow-checks must be boolean")).transpose()?;
    let mut analysis = Analysis { hits: vec![], handlers: vec![],
        implemented_rules: vec!["arithmetic/release-overflow-checks"] };
    if checks != Some(true) {
        analysis.hits.push(Hit { tool: "oms-sast", rule_id: "arithmetic/release-overflow-checks",
            class: "arithmetic", severity: "medium",
            location: Location { file: path.into(), line: 1, handler: None },
            message: "This manifest does not explicitly enable release overflow checks. Review the effective workspace profile and arithmetic; configuration and environment overrides are not resolved." });
    }
    Ok(analysis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_disabled_release_checks_are_signals() {
        for source in ["[package]\nname='vault'", "[profile.release]\noverflow-checks=false",
            "[profile.dev]\noverflow-checks=true", "# overflow-checks=true\n[profile.release]\nopt-level=3"] {
            let result = analyze("Cargo.toml", source).unwrap();
            assert_eq!(result.hits.len(), 1, "{source}");
            assert_eq!(result.hits[0].rule_id, "arithmetic/release-overflow-checks");
            assert_eq!(result.hits[0].location.file, "Cargo.toml");
            assert_eq!(result.hits[0].location.line, 1);
        }
    }

    #[test]
    fn explicit_true_supports_toml_table_forms() {
        for source in ["[profile.release]\noverflow-checks=true",
            "profile.release.overflow-checks = true", "profile={release={overflow-checks=true}}"] {
            let result = analyze("Cargo.toml", source).unwrap();
            assert!(result.hits.is_empty());
            assert_eq!(result.implemented_rules, ["arithmetic/release-overflow-checks"]);
            assert!(result.handlers.is_empty());
        }
    }

    #[test]
    fn malformed_profiles_fail_instead_of_reporting_clean() {
        for source in ["[", "profile=false", "[profile]\nrelease=3",
            "[profile.release]\noverflow-checks='true'", "[profile.release]\noverflow-checks=1"] {
            assert!(analyze("Cargo.toml", source).is_err(), "{source}");
        }
    }

    #[test]
    fn unrelated_override_is_not_global_protection() {
        for source in ["[profile.release.package.dependency]\noverflow-checks=true",
            "[profile.release.build-override]\noverflow-checks=true"] {
            assert_eq!(analyze("Cargo.toml", source).unwrap().hits.len(), 1);
        }
    }
}
