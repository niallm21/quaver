use serde::{Deserialize, Serialize};
use chromaprint::{fingerprint_audio, Algorithm};
use std::path::Path;
use std::fs::File;
use symphonia::core::probe::Hint;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::formats::FormatOptions;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::audio::SampleBuffer;
use reqwest::Client;

#[derive(Serialize, Deserialize, Debug)]
pub struct OnlineMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

#[derive(Deserialize, Debug)]
struct AcoustIdResponse {
    status: String,
    results: Vec<AcoustIdResult>,
}

#[derive(Deserialize, Debug)]
struct AcoustIdResult {
    recordings: Option<Vec<AcoustIdRecording>>,
}

#[derive(Deserialize, Debug)]
struct AcoustIdRecording {
    title: Option<String>,
    artists: Option<Vec<AcoustIdArtist>>,
    releasegroups: Option<Vec<AcoustIdReleaseGroup>>,
}

#[derive(Deserialize, Debug)]
struct AcoustIdArtist {
    name: String,
}

#[derive(Deserialize, Debug)]
struct AcoustIdReleaseGroup {
    title: String,
}

#[derive(Deserialize, Debug)]
struct ItunesSearchResponse {
    results: Vec<ItunesAlbumResult>,
}

#[derive(Deserialize, Debug)]
struct ItunesAlbumResult {
    #[serde(rename = "artworkUrl100")]
    artwork_url_100: Option<String>,
}

const ACOUSTID_CLIENT_KEY: &str = "iceEh8FwO1";

async fn search_itunes_art_url(
    client: &Client,
    query: &str,
    entity: &str,
) -> Result<Option<String>, String> {
    let resp = client
        .get("https://itunes.apple.com/search")
        .query(&[
            ("term", query),
            ("media", "music"),
            ("entity", entity),
            ("limit", "1"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("iTunes API error: {} - {}", status, text));
    }

    let search = resp
        .json::<ItunesSearchResponse>()
        .await
        .map_err(|e| e.to_string())?;

    Ok(search.results.into_iter().find_map(|result| result.artwork_url_100))
}

async fn download_art(client: &Client, art_url: String) -> Result<Option<Vec<u8>>, String> {
    let high_res_art_url = art_url.replace("100x100bb", "600x600bb");
    let art_resp = client
        .get(high_res_art_url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !art_resp.status().is_success() {
        return Ok(None);
    }

    let bytes = art_resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        Ok(None)
    } else {
        Ok(Some(bytes.to_vec()))
    }
}

pub async fn fetch_album_art(query: &str) -> Result<Option<Vec<u8>>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(None);
    }

    let client = Client::new();

    for entity in ["album", "song"] {
        if let Some(art_url) = search_itunes_art_url(&client, query, entity).await? {
            if let Some(bytes) = download_art(&client, art_url).await? {
                return Ok(Some(bytes));
            }
        }
    }

    Ok(None)
}

pub async fn fetch_metadata(file_path: &str) -> Result<OnlineMetadata, String> {
    let path = Path::new(file_path);
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }

    let format_opts: FormatOptions = Default::default();
    let metadata_opts: MetadataOptions = Default::default();
    let decoder_opts: DecoderOptions = Default::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &metadata_opts)
        .map_err(|e| e.to_string())?;

    let mut format = probed.format;
    let track = format.default_track().ok_or("No default track found")?;
    
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &decoder_opts)
        .map_err(|e| e.to_string())?;

    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2) as u32;
    
    let duration = if let Some(n_frames) = track.codec_params.n_frames {
        if sample_rate > 0 { n_frames as f64 / sample_rate as f64 } else { 0.0 }
    } else {
        0.0
    };

    let max_samples = 120 * sample_rate as usize * channels as usize;
    let mut all_samples = Vec::new();
    let mut sample_buf = None;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(_) => break,
        };

        match decoder.decode(&packet) {
            Ok(audio_buf) => {
                if sample_buf.is_none() {
                    let spec = *audio_buf.spec();
                    let dur = audio_buf.capacity() as u64;
                    sample_buf = Some(SampleBuffer::<i16>::new(dur, spec));
                }
                
                if let Some(buf) = &mut sample_buf {
                    buf.copy_interleaved_ref(audio_buf);
                    all_samples.extend_from_slice(buf.samples());
                }
            }
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(_) => break,
        }

        if all_samples.len() >= max_samples {
            break;
        }
    }

    if all_samples.is_empty() {
        return Err("No audio decoded".to_string());
    }

    let fp = fingerprint_audio(&all_samples, sample_rate, channels as u16, Algorithm::default())
        .map_err(|_| "Failed to generate fingerprint")?;

    let fingerprint = fp.encoded();

    if fingerprint.is_empty() {
        return Err("Generated fingerprint is empty".to_string());
    }

    // Call AcoustID
    let url = format!(
        "https://api.acoustid.org/v2/lookup?client={}&meta=recordings+releasegroups+compress&duration={}&fingerprint={}",
        ACOUSTID_CLIENT_KEY,
        duration.round() as u64,
        fingerprint
    );

    let client = Client::new();
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("AcoustID API error: {} - {}", status, text));
    }
    
    let json_resp: AcoustIdResponse = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    if json_resp.status != "ok" {
        return Err("AcoustID returned non-ok status".to_string());
    }

    // Extract best match
    let mut best_meta = OnlineMetadata { title: None, artist: None, album: None };

    for result in json_resp.results {
        if let Some(recordings) = result.recordings {
            for rec in recordings {
                if best_meta.title.is_none() && rec.title.is_some() {
                    best_meta.title = rec.title.clone();
                }
                
                if best_meta.artist.is_none() {
                    if let Some(artists) = &rec.artists {
                        if !artists.is_empty() {
                            best_meta.artist = Some(artists[0].name.clone());
                        }
                    }
                }

                if best_meta.album.is_none() {
                    if let Some(rgs) = &rec.releasegroups {
                        if !rgs.is_empty() {
                            best_meta.album = Some(rgs[0].title.clone());
                        }
                    }
                }

                // If we got everything, we can stop
                if best_meta.title.is_some() && best_meta.artist.is_some() && best_meta.album.is_some() {
                    return Ok(best_meta);
                }
            }
        }
    }

    if best_meta.title.is_some() || best_meta.artist.is_some() {
        Ok(best_meta)
    } else {
        Err("No matching recordings found".to_string())
    }
}
