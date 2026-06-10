use std::path::Path;
use symphonia::core::probe::Hint;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::formats::FormatOptions;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::audio::{AudioBufferRef, Signal};
use std::fs::File;

pub fn generate_peaks(file_path: &Path, num_peaks: usize) -> Result<Vec<f32>, String> {
    let file = File::open(file_path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = file_path.extension().and_then(|s| s.to_str()) {
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

    let mut all_samples: Vec<f32> = Vec::new();
    // In a real app we might not want to hold all samples in memory if it's huge,
    // but for peaks generation we can chunk it. For simplicity, let's process in chunks
    // and keep a running window for peaks, or just read all. Let's do running window if possible,
    // or just collect and then downsample. To save memory, let's collect into a smaller buffer.
    
    // Instead of collecting all, let's just collect all and downsample for simplicity first,
    // unless it OOMs. A 5 min song at 44.1kHz is 13M samples, which is 52MB of f32. It's fine.

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                break; // EOF
            }
            Err(symphonia::core::errors::Error::DecodeError(_)) => {
                continue; // Ignore decode errors and keep going
            }
            Err(_) => break, // Other errors
        };

        match decoder.decode(&packet) {
            Ok(AudioBufferRef::F32(buf)) => {
                // Assuming stereo or mono, let's just take the first channel or mix them.
                // We'll just take channel 0.
                all_samples.extend(buf.chan(0));
            }
            Ok(AudioBufferRef::S16(buf)) => {
                let chan = buf.chan(0);
                all_samples.extend(chan.iter().map(|&s| s as f32 / i16::MAX as f32));
            }
            Ok(AudioBufferRef::S24(buf)) => {
                let chan = buf.chan(0);
                // Symphonia S24 is usually stored in i32
                all_samples.extend(chan.iter().map(|&s| s.inner() as f32 / 8388607.0));
            }
            Ok(AudioBufferRef::S32(buf)) => {
                let chan = buf.chan(0);
                all_samples.extend(chan.iter().map(|&s| s as f32 / i32::MAX as f32));
            }
            Ok(_) => {
                // Ignore other formats for now or implement if needed
            }
            Err(symphonia::core::errors::Error::DecodeError(_)) => {
                continue;
            }
            Err(_) => break,
        }
    }

    if all_samples.is_empty() {
        return Err("No audio samples decoded".to_string());
    }

    // Now downsample to `num_peaks`
    let chunk_size = (all_samples.len() / num_peaks).max(1);
    let mut peaks = Vec::with_capacity(num_peaks * 2);

    for chunk in all_samples.chunks(chunk_size) {
        let mut min = f32::MAX;
        let mut max = f32::MIN;
        for &sample in chunk {
            if sample < min { min = sample; }
            if sample > max { max = sample; }
        }
        peaks.push(min);
        peaks.push(max);
    }

    Ok(peaks)
}
