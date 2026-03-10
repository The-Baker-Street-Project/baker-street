use bakerst_install::manifest::{Manifest, ManifestImage};

#[test]
fn test_parse_manifest() {
    let json = r#"{
        "schemaVersion": 1,
        "version": "0.6.0",
        "releaseDate": "2026-03-10T00:00:00Z",
        "templateUrl": "https://example.com/template.tar.gz",
        "templateSha256": "abc123",
        "images": [{
            "name": "bakerst-brain",
            "image": "ghcr.io/the-baker-street-project/bakerst-brain",
            "tag": "0.6.0",
            "required": true,
            "architectures": ["amd64", "arm64"]
        }],
        "installers": [{
            "os": "linux",
            "arch": "amd64",
            "url": "https://example.com/installer",
            "sha256": "abc123"
        }]
    }"#;
    let manifest: Manifest = serde_json::from_str(json).unwrap();
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.version, "0.6.0");
    assert_eq!(manifest.images.len(), 1);
    assert_eq!(manifest.images[0].architectures, vec!["amd64", "arm64"]);
}

#[test]
fn test_schema_version_check() {
    let manifest = Manifest {
        schema_version: 99,
        ..Default::default()
    };
    assert!(manifest.check_schema_version(1).is_err());
}

#[test]
fn test_schema_version_zero_rejected() {
    let manifest = Manifest {
        schema_version: 0,
        ..Default::default()
    };
    assert!(manifest.check_schema_version(1).is_err());
}

#[test]
fn test_required_images() {
    let manifest = Manifest {
        images: vec![
            ManifestImage { name: "brain".into(), required: true, ..Default::default() },
            ManifestImage { name: "voice".into(), required: false, ..Default::default() },
        ],
        ..Default::default()
    };
    let required: Vec<_> = manifest.required_images().collect();
    assert_eq!(required.len(), 1);
    assert_eq!(required[0].name, "brain");
}

#[test]
fn test_from_json_validates_schema() {
    let json = r#"{"schemaVersion": 99, "version": "1.0", "templateUrl": "", "templateSha256": "", "images": []}"#;
    assert!(Manifest::from_json(json).is_err());
}
