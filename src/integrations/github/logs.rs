use std::{
    collections::BTreeSet,
    io::{BufRead, BufReader, Cursor, Read},
    sync::LazyLock,
};

use regex::Regex;
use zip::ZipArchive;

use crate::error::IntegrationError;

pub const LOG_LIMIT: usize = 16 * 1024 * 1024;

pub fn created_pull_requests(data: &[u8], repository: &str) -> Result<Vec<u64>, IntegrationError> {
    static HEADER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^\S+\s+(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL): (.*) \(repository=([^,)]+)(?:, [^)]*)?\)$").unwrap()
    });
    static FIELD: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"^\S+\s+"pr": ([1-9][0-9]*),?$"#).unwrap());
    static LEVEL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\S+\s+(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL): ").unwrap());

    if data.len() > LOG_LIMIT {
        return Err(IntegrationError::TooLarge);
    }
    let mut archive =
        ZipArchive::new(Cursor::new(data)).map_err(|_| IntegrationError::InvalidLogArchive)?;
    let mut remaining = LOG_LIMIT;
    let mut numbers = BTreeSet::new();
    let mut finished = false;

    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|_| IntegrationError::InvalidLogArchive)?;
        if file.is_dir() {
            continue;
        }
        if file.size() > remaining as u64 {
            return Err(IntegrationError::TooLarge);
        }
        // Stream each entry instead of retaining a second complete log archive.
        let mut reader = BufReader::new(file.take(remaining as u64 + 1));
        let mut bytes = Vec::new();
        let mut pending = false;
        loop {
            bytes.clear();
            let count = reader
                .read_until(b'\n', &mut bytes)
                .map_err(|_| IntegrationError::InvalidLogArchive)?;
            if count == 0 {
                break;
            }
            if count > remaining {
                return Err(IntegrationError::TooLarge);
            }
            remaining -= count;
            let line = std::str::from_utf8(&bytes)
                .map_err(|_| IntegrationError::InvalidLogArchive)?
                .trim_end_matches(['\r', '\n']);
            if LEVEL.is_match(line) {
                if pending {
                    return Err(IntegrationError::IncompleteCreation);
                }
                if let Some(header) = HEADER.captures(line)
                    && header[2].eq_ignore_ascii_case(repository)
                {
                    match &header[1] {
                        "PR created" => pending = true,
                        "Repository finished" => finished = true,
                        _ => {}
                    }
                }
            } else if pending && let Some(field) = FIELD.captures(line) {
                numbers.insert(
                    field[1]
                        .parse()
                        .map_err(|_| IntegrationError::IncompleteCreation)?,
                );
                pending = false;
            }
        }
        if pending {
            return Err(IntegrationError::IncompleteCreation);
        }
    }
    if !finished {
        return Err(IntegrationError::UnverifiedLogs);
    }
    Ok(numbers.into_iter().collect())
}
