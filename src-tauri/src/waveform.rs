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

    // Stream samples into fixed-size min/max buckets instead of holding the whole
    // decoded file in memory: ~8 bytes per 2048 samples keeps even multi-hour files
    // to a few MB. Buckets are downsampled to `num_peaks` pairs at the end.
    const SAMPLES_PER_BUCKET: usize = 2048;
    let mut buckets: Vec<(f32, f32)> = Vec::new();
    let mut cur_min = f32::MAX;
    let mut cur_max = f32::MIN;
    let mut filled = 0usize;

    let mut push_sample = |sample: f32| {
        if sample < cur_min { cur_min = sample; }
        if sample > cur_max { cur_max = sample; }
        filled += 1;
        if filled == SAMPLES_PER_BUCKET {
            buckets.push((cur_min, cur_max));
            cur_min = f32::MAX;
            cur_max = f32::MIN;
            filled = 0;
        }
    };

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

        // Channel 0 only; good enough for a waveform.
        match decoder.decode(&packet) {
            Ok(AudioBufferRef::F32(buf)) => {
                for &s in buf.chan(0) { push_sample(s); }
            }
            Ok(AudioBufferRef::F64(buf)) => {
                for &s in buf.chan(0) { push_sample(s as f32); }
            }
            Ok(AudioBufferRef::S16(buf)) => {
                for &s in buf.chan(0) { push_sample(s as f32 / i16::MAX as f32); }
            }
            Ok(AudioBufferRef::S24(buf)) => {
                // Symphonia S24 is usually stored in i32
                for &s in buf.chan(0) { push_sample(s.inner() as f32 / 8388607.0); }
            }
            Ok(AudioBufferRef::S32(buf)) => {
                for &s in buf.chan(0) { push_sample(s as f32 / i32::MAX as f32); }
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

    if filled > 0 {
        buckets.push((cur_min, cur_max));
    }

    if buckets.is_empty() {
        return Err("No audio samples decoded".to_string());
    }

    // Now downsample to `num_peaks`
    let group_size = (buckets.len() / num_peaks).max(1);
    let mut peaks = Vec::with_capacity(num_peaks * 2);

    for group in buckets.chunks(group_size) {
        let mut min = f32::MAX;
        let mut max = f32::MIN;
        for &(lo, hi) in group {
            if lo < min { min = lo; }
            if hi > max { max = hi; }
        }
        peaks.push(min);
        peaks.push(max);
    }

    Ok(peaks)
}
