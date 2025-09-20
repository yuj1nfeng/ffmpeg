import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

/**
 * @async
 * @function getVideoDuration 获取视频时长（秒）
 * @param {string} input - 视频文件路径
 * @returns {Promise<number>} - 视频时长（秒）
 * @throws {Error} - 如果获取失败，抛出错误
 */
async function getVideoDuration(input) {
    return await Bun.$`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${input}`.text().then((output) => parseFloat(output.trim()));
}

async function generateThumbnail(input) {
    const output = path.join(os.tmpdir(), `${Math.random().toString(36).substring(2, 15)}.jpg`);
    await Bun.$`ffmpeg -ss 1 -i ${input} -vframes 1 -q:v 2 -y  ${output}`.quiet();
    const base64_img = (await fs.readFile(output)).toBase64();
    await fs.unlink(output);
    return `data:image/jpeg;base64,${base64_img}`;
}

/**
 * 为输入的视频或图片文件添加水印。
 *
 * @async
 * @function addWatermark
 * @param {string} input - 输入文件的路径。
 * @param {string} watermark - 水印图片的路径。
 * @param {string} output - 输出文件的路径。
 * @param {Object} [opts={}] - 配置选项。
 * @param {string} [opts.position='right-top'] - 水印位置，可选值：right-top left-top right-bottom left-bottom {x: number, y: number}
 * @param {number} [opts.margin=10] - 水印与边缘的间距（像素）。
 * @param {number} [opts.scale=1] - 水印的缩放比例。
 * @param {number} [opts.opacity=1] - 水印的透明度，取值范围为 0 到 1。
 * @param {number} [opts.rotate=0] - 水印的旋转角度（度数）
 * @param {number} [opts.crf=23]
 * @param {string} [opts.preset='ultrafast']
 * @returns {Promise<string>} - 返回输出文件的绝对路径。
 * @throws {Error} - 如果添加水印失败，抛出错误。
 */
async function addWatermark(input, watermark, output, opts = {}) {
    const { progress_cb = null, position = 'left-top', margin = 10, scale = 1, opacity = 1.0, rotate = 0, crf = 23, preset = 'ultrafast' } = opts;
    // 计算水印位置
    let overlay_pos = '';
    // W:视频宽度 H:视频高度 w:水印宽度 h:水印高度
    switch (position) {
        case 'left-top':
            overlay_pos = `x=${margin}:y=${margin}`;
            break;
        case 'right-top':
            overlay_pos = `x=W-w-${margin}:y=${margin}`;
            break;
        case 'left-bottom':
            overlay_pos = `x=${margin}:y=H-h-${margin}`;
            break;
        case 'right-bottom':
            overlay_pos = `x=W-w-${margin}:y=H-h-${margin}`;
            break;
        default:
            overlay_pos = `x=${position.x + margin}:y=${position.y + margin}`;
            break;
    }
    const water_filter = [];
    water_filter.push(`format=rgba`);
    if (rotate !== 0) water_filter.push(`rotate=${rotate}*(PI/180):c=none`);
    water_filter.push(`colorchannelmixer=aa=${opacity}`);
    water_filter.push(`scale=iw*${scale}:-1`);
    const filter_complex = [`[1:v]${water_filter.join(',')}[wm]`, `[0][wm]overlay=${overlay_pos}`];
    const cmds = ['ffmpeg', '-y'];
    cmds.push('-i', input);
    cmds.push('-i', watermark);
    cmds.push('-filter_complex', filter_complex.join(';'));
    cmds.push('-crf', crf.toString());
    cmds.push('-preset', preset);
    cmds.push(output);
    console.log(cmds.join(' '));
    const proc = Bun.spawn(cmds, { stdout: 'pipe', stderr: 'pipe' });
    const [progress_stream, err_stream] = proc.stderr.tee();
    if (progress_cb != null) {
        const progressHandler = createProgressHandler(progress_cb);
        const duration = await getVideoDuration(input);
        progressHandler.setTotalDuration(duration);
        await progress_stream.pipeTo(new WritableStream({ write: (chunk) => progressHandler.handleOutput(chunk) }));
    }
    await proc.exited;
    if (proc.exitCode !== 0) {
        const error = await new Response(err_stream).text();
        throw new Error(`FFMPEG处理失败,错误信息:\r\n ${error}`);
    }
    return path.resolve(output);
}

/**
 * @async
 * @function extraAudio 音频提取辅助函数
 * @param {string} input  输入视频文件路径
 * @param {string} output 输出文件路径
 * @param {Object} [opts={}] 配置选项
 * @param {string} [opts.codec='copy'] 编码器
 * @param {string} [opts.bitrate=''] 比特率
 * @param {function} [opts.progress_cb=null] 进度回调函数
 * @returns {Promise<string>} 提取完成后返回输出文件的绝对路径
 */
async function extraAudio(input, output, opts = {}) {
    let { codec = '', bitrate = '', progress_cb = null } = opts;
    const meta = await getMetadata(input);
    if (codec === 'copy') codec = meta.audio.codec;
    if (bitrate == '') bitrate = meta.audio.bit_rate;
    const cmds = ['ffmpeg', '-y'];
    cmds.push('-i', input);
    cmds.push('-vn');
    if (codec !== '') cmds.push('-acodec', codec);
    cmds.push('-b:a', bitrate);
    cmds.push(output);
    const proc = Bun.spawn(cmds, { stdout: 'pipe', stderr: 'pipe' });
    const [progress_stream, err_stream] = proc.stderr.tee();
    if (progress_cb != null) {
        const progressHandler = createProgressHandler(progress_cb);
        progressHandler.setTotalDuration(meta.video.duration);
        await progress_stream.pipeTo(new WritableStream({ write: (chunk) => progressHandler.handleOutput(chunk) }));
    }
    await proc.exited;
    if (proc.exitCode !== 0) {
        const error = await new Response(err_stream).text();
        throw new Error(`FFMPEG处理失败,错误信息:\r\n ${error}`);
    }
    return path.resolve(output);
}

/**
 * @async
 * @function convertVideoFmt 转换视频格式
 * @param {string} input 输入文件路径
 * @param {string} output 输出文件路径
 * @param {Object} [opts={}] 配置选项
 * @param {string} [opts.codec='libx264'] 编码器
 * @param {number} [opts.crf=23] 压缩率
 * @param {string} [opts.preset='ultrafast'] 预设
 * @param {function} [opts.progress_cb=null] 进度回调函数
 * @returns
 */
async function convertVideoFmt(input, output, opts = {}) {
    const { codec = '', crf = 23, preset = 'ultrafast', progress_cb = null } = opts;
    const cmds = ['ffmpeg', '-y'];
    cmds.push('-i', input);
    if (codec !== '') cmds.push('-c:v', codec);
    cmds.push('-crf', crf.toString());
    cmds.push('-preset', preset);
    cmds.push(output);
    const proc = Bun.spawn(cmds, { stdout: 'pipe', stderr: 'pipe' });
    const [progress_stream, err_stream] = proc.stderr.tee();
    if (progress_cb != null) {
        const progressHandler = createProgressHandler(progress_cb);
        const duration = await getVideoDuration(input);
        progressHandler.setTotalDuration(duration);
        await progress_stream.pipeTo(new WritableStream({ write: (chunk) => progressHandler.handleOutput(chunk) }));
    }
    await proc.exited;
    if (proc.exitCode !== 0) {
        const error = await new Response(err_stream).text();
        throw new Error(`FFMPEG处理失败,错误信息:\r\n ${error}`);
    }
    return path.resolve(output);
}

/**
 * @async
 * @function remvoeAudio 去除音频
 * @param {string} input 输入文件路径
 * @param {string} output 输出文件路径
 * @param {Object} [opts={}] 配置选项
 * @param {string} [opts.codec='libx264'] 编码器
 * @param {number} [opts.crf=23] 压缩率
 * @param {string} [opts.preset='ultrafast'] 预设
 * @param {function} [opts.progress_cb=null] 进度回调函数
 * @returns
 */
async function remvoeAudio(input, output, opts = {}) {
    const { codec = '', crf = 23, preset = 'ultrafast', progress_cb = null } = opts;
    const cmds = ['ffmpeg', '-y'];
    cmds.push('-i', input);
    cmds.push('-an'); // 去除音频
    if (codec !== '') cmds.push('-c:v', codec);
    cmds.push('-crf', crf.toString());
    cmds.push('-preset', preset);
    cmds.push(output);
    const proc = Bun.spawn(cmds, { stdout: 'pipe', stderr: 'pipe' });
    const [progress_stream, err_stream] = proc.stderr.tee();
    if (progress_cb != null) {
        const progressHandler = createProgressHandler(progress_cb);
        const duration = await getVideoDuration(input);
        progressHandler.setTotalDuration(duration);
        await progress_stream.pipeTo(new WritableStream({ write: (chunk) => progressHandler.handleOutput(chunk) }));
    }
    await proc.exited;
    if (proc.exitCode !== 0) {
        const error = await new Response(err_stream).text();
        throw new Error(`FFMPEG处理失败,错误信息:\r\n ${error}`);
    }
    return path.resolve(output);
}

/**
 * @async
 * @function sliceVideo 裁剪视频文件
 * @param {string} input - 输入视频文件的路径。
 * @param {string} output - 输出视频文件的路径。
 * @param {Object} [opts={}] - 配置选项。
 * @param {number} [opts.start=0] - 裁剪的起始时间（秒）。
 * @param {number} [opts.duration=10] - 裁剪的时长（秒）。
 * @param {function} [opts.progress_cb=null] - 进度回调函数。
 * @returns {Promise<string>} - 返回裁剪后的视频文件的路径。
 * @throws {Error} - 如果裁剪失败，抛出错误。
 */
async function sliceVideo(input, output, opts = {}) {
    let { progress_cb = null, start = 0, duration = 10 } = opts;
    const meta = await getMetadata(input);
    if (start < 0) start = 0;
    if (duration < 0) duration = 0;
    if (start > meta.video.duration) start = meta.video.duration;
    if (start + duration > meta.video.duration) duration = meta.video.duration - start;
    const cmds = ['ffmpeg', '-y'];
    cmds.push('-ss', start.toString());
    cmds.push('-i', input);
    cmds.push('-t', duration.toString());
    cmds.push('-c:v', 'copy');
    cmds.push('-c:a', 'copy');
    cmds.push(output);
    const proc = Bun.spawn(cmds, { stdout: 'pipe', stderr: 'pipe' });
    const [progress_stream, err_stream] = proc.stderr.tee();
    if (progress_cb != null) {
        const progressHandler = createProgressHandler(progress_cb);
        progressHandler.setTotalDuration(duration);
        await progress_stream.pipeTo(new WritableStream({ write: (chunk) => progressHandler.handleOutput(chunk) }));
    }
    await proc.exited;
    if (proc.exitCode !== 0) {
        const error = await new Response(err_stream).text();
        throw new Error(`FFMPEG处理失败,错误信息:\r\n ${error}`);
    }
    return path.resolve(output);
}

/**
 * @async
 * @function concatVideos 拼接多个视频文件
 * @param {string[]} inputs - 输入视频文件路径数组
 * @param {string} output - 输出视频文件路径
 * @param {Object} [opts={}] - 配置选项
 * @param {function} [opts.progress_cb=null] - 进度回调函数
 * @param {string} [opts.video_codec='libx264'] - 视频编码器
 * @param {string} [opts.audio_codec='aac'] - 视频编码器
 * @param {number} [opts.crf=23] - 压缩率
 * @param {string} [opts.preset='ultrafast'] - 预设
 * @param {string} [opts.preset='fps'] -
 * @param {string} [opts.preset='scale'] - 视频缩放 {width: 1920, height: 1080}
 * @returns {Promise<string>} - 返回拼接后的视频文件绝对路径
 * @throws {Error} - 如果拼接失败，抛出错误
 */
async function concatVideos(inputs, output, opts = {}) {
    const { progress_cb = null, scale, fps, video_codec = 'libx264', audio_codec = 'aac', crf = 23, preset = 'ultrafast' } = opts;
    if (inputs.length === 0) throw new Error('没有输入视频文件');
    const list_file = path.join(os.tmpdir(), `${Bun.randomUUIDv7()}.txt`);
    await fs.rm(list_file, { recursive: true, force: true });
    const list_content = inputs.map((input) => `file '${path.resolve(input).replace(/\\/g, '/')}'`).join('\n');
    await fs.writeFile(list_file, list_content, 'utf8');
    const cmds = ['ffmpeg', '-y'];
    cmds.push('-f', 'concat');
    cmds.push('-safe', '0');
    cmds.push('-i', list_file);
    cmds.push('-c:v', video_codec);
    cmds.push('-c:a', audio_codec);
    cmds.push('-crf', crf.toString());
    if (scale) cmds.push('-vf', `scale=${scale.width}:${scale.height}`);
    if (fps) cmds.push('-r', fps.toString());
    cmds.push('-preset', preset);
    cmds.push(output);
    const proc = Bun.spawn(cmds, { stdout: 'pipe', stderr: 'pipe' });
    const [progress_stream, err_stream] = proc.stderr.tee();

    if (progress_cb != null) {
        const progressHandler = createProgressHandler(progress_cb);
        const duration = (await Promise.all(inputs.map(getVideoDuration))).reduce((sum, duration) => sum + duration, 0);
        progressHandler.setTotalDuration(duration);
        await progress_stream.pipeTo(new WritableStream({ write: (chunk) => progressHandler.handleOutput(chunk) }));
    }
    await proc.exited;
    if (proc.exitCode !== 0) {
        const error_output = await new Response(err_stream).text();
        throw new Error(`FFMPEG处理失败,错误信息:\r\n ${error_output}`);
    }
    return path.resolve(output);
}

/**
 * @async
 * @function getVideoMetadata 获取视频文件信息
 * @param {string} input 输入视频文件路径
 * @returns {Promise<object>} 返回视频信息对象，包含时长、分辨率、码率等信息
 */
async function getMetadata(input) {
    const info = await Bun.$`ffprobe -v error -show_format -show_streams -print_format json "${input}"`.json();
    // 提取视频流信息
    const videoStream = info.streams.find((stream) => stream.codec_type === 'video');
    const audioStream = info.streams.find((stream) => stream.codec_type === 'audio');

    return {
        video: videoStream
            ? {
                  codec: videoStream.codec_name,
                  width: videoStream.width,
                  height: videoStream.height,
                  duration: parseFloat(videoStream.duration),
                  bit_rate: parseInt(videoStream.bit_rate || info.format.bit_rate),
                  frame_rate: videoStream.r_frame_rate,
                  pixel_format: videoStream.pix_fmt,
              }
            : null,
        audio: audioStream
            ? {
                  codec: audioStream.codec_name,
                  sample_rate: parseInt(audioStream.sample_rate),
                  channels: audioStream.channels,
                  bit_rate: parseInt(audioStream.bit_rate),
                  duration: parseFloat(audioStream.duration),
              }
            : null,
        duration: 0,
        ...info.format,
    };
}

/**
 * @async
 * @function autoClipVideos 自动裁剪视频(在输入目录中寻找所有视频文件,从每个视频随机裁剪 min_sec 到 max_sec 秒,初始到 out_dir 中)
 * @param {string} root_dir 输入目录路径
 * @param {Object} [opts={}] 配置选项
 * @param {number} [opts.min_sec=5] 最小裁剪时长
 * @param {number} [opts.max_sec=10] 最大裁剪时长
 * @param {string} [opts.file_extensions='mp4,avi,flv,wmv,rmvb,mkv'] 文件扩展名
 * @param {function} [opts.progress_cb=null] 进度回调函数
 * @returns {Promise<Array<string>>} 输出文件路径数组
 */
async function autoClipVideos(root_dir, opts = {}) {
    const { min_sec = 5, max_sec = 10, file_extensions = 'mp4,avi,flv,wmv,rmvb,mkv', progress_cb = null } = opts;
    let files = await fs.readdir(root_dir, { withFileTypes: true, recursive: true });
    const includes = file_extensions.split(',').map((p) => `.${p}`);
    files = files.filter((p) => p.isFile() && includes.includes(path.extname(p.name.toLowerCase())));
    files = files.map((file) => path.join(file.parentPath, file.name));
    if (files.length === 0) return [];
    const clip_files = [];
    // 处理每个视频文件
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // console.log(`处理文件 ${i + 1}/${files.length}: ${path.basename(file)}`);
        try {
            const duration = await getVideoDuration(file);
            if (duration < min_sec) {
                // console.log(`  跳过: 视频时长 ${duration.toFixed(2)} 秒太短`);
                continue;
            }
            const clip_duration = Math.floor(Math.random() * (max_sec - min_sec + 1)) + min_sec;
            const max_start = Math.max(0, duration - clip_duration);
            const start_time = Math.floor(Math.random() * max_start);
            const output = path.join(os.tmpdir(), `${path.basename(file, path.extname(file))}-${start_time}-${start_time + clip_duration}.${path.extname(file)}`);
            const clip_file = await sliceVideo(file, output, { start: start_time, duration: clip_duration });
            clip_files.push(clip_file);
            // console.log(`  剪辑: ${start_time}-${start_time + clip_duration}秒 (${clip_duration}秒)`);
        } catch (error) {
            console.error(` ${file} 处理失败: ${error.message}`);
        }
        const progress = ((i + 1) / files.length) * 100;
        if (progress_cb != null) progress_cb(progress.toFixed(2));
    }
    return clip_files;
}

/**
 * @async
 * @function autoCutVideo 自动剪辑视频
 * @description  从指定目录获取所有视频文件，随机裁剪5-10秒片段，然后拼接成一个视频
 * @param {string} root_dir - 输入目录路径
 * @param {string} output - 输出视频文件路径
 * @param {object} [opts] - 可选参数对象
 * @param {string} [opts.file_extensions] - 视频文件扩展名数组
 * @param {number} [opts.min_sec=5] - 每个视频最小裁剪时长
 * @param {number} [opts.max_sec=10] - 每个视频最大裁剪时长
 * @param {string} [opts.transition_mode] - 转场特效类型，支持：fade, wipe, slide, dissolve
 * @param {number} [opts.transition_duration=1] - 转场持续时间，单位：秒
 *
 */
async function autoCutVideo(root_dir, output, opts = {}) {
    const { min_sec = 5, max_sec = 10, file_extensions = 'mp4,mov', transition_mode, transition_duration, progress_cb = null } = opts;
    const clip_cb = (progress) => progress_cb != null && progress_cb((Number(progress) / 2).toFixed(2));
    const concat_cb = (progress) => progress_cb != null && progress_cb((Number(progress) / 2 + 50).toFixed(2));
    let clip_files = [];
    try {
        clip_files = await autoClipVideos(root_dir, { min_sec, max_sec, file_extensions, progress_cb: clip_cb });
        await concatVideos(clip_files, output, { transition_mode, transition_duration, progress_cb: concat_cb });
        return path.resolve(output);
    } catch (error) {
        throw error;
    } finally {
        for (const file of clip_files) await fs.unlink(file);
    }
}

async function getCodecs() {
    const text = await Bun.$`ffmpeg -hide_banner -v quiet -codecs`.text();
    const lines = text.split('-------')[1].split('\n');
    const typeMap = (flag) => {
        switch (flag) {
            case 'V':
                return 'video';
            case 'A':
                return 'audio';
            case 'S':
                return 'subtitle';
            case 'D':
                return 'data';
            case 'T':
                return 'attachment';
        }
    };

    const codecs = [];
    for (const line of lines) {
        if (line === '' || line === '\r') continue;
        const flags = line.slice(1, 7);
        const codec = line.slice(7).trim().split(' ')[0].trim();
        const desc = line.split(codec)[1].trim();
        codecs.push({
            codec: codec,
            type: typeMap(flags[2]),
            can_decode: flags[0] === 'D',
            can_encode: flags[1] === 'E',
            intra_frame_only: flags[3] === 'I',
            lossy_compression: flags[4] === 'L',
            lossless_compression: flags[5] === 'S',
            desc: desc,
        });
    }
    return codecs;
}

async function getAvailableVideoEncoders() {
    const result = await getCodecs();
    return result.filter((p) => p.type === 'video' && p.can_encode).map((p) => p.codec);
}
async function getAvailableVideoDecoders() {
    const result = await getCodecs();
    return result.filter((p) => p.type === 'video' && p.can_decode).map((p) => p.codec);
}

async function getAvailableAudioEncoders() {
    const result = await getCodecs();
    return result.filter((p) => p.type === 'audio' && p.can_encode).map((p) => p.codec);
}
async function getAvailableAudioDecoders() {
    const result = await getCodecs();
    return result.filter((p) => p.type === 'audio' && p.can_decode).map((p) => p.codec);
}

/**
 * 创建进度处理回调函数
 * @param {function} progress_cb 外部进度回调
 * @returns {object} 包含处理进度的对象
 * @description 该函数创建一个进度处理回调函数，用于处理FFmpeg的输出，提取进度信息并调用外部进度回调函数。
 * 使用方式
 * const progressHandler = createProgressHandler(progress_cb);
 * progressHandler.setTotalDuration(duration);  number | string(‘00:00:30’)
 * process.stderr.pipeTo(new WritableStream({ write: (chunk) => progressHandler.handleOutput(chunk) }));
 */
function createProgressHandler(progress_cb = () => {}) {
    let totalDuration = 0;
    // 解析时长字符串为秒数
    const parseDuration = (timeStr) => {
        const [hours, minutes, seconds] = timeStr.split(':').map(Number);
        return hours * 3600 + minutes * 60 + seconds;
    };

    // 处理FFmpeg输出的回调函数
    const handleOutput = (chunk) => {
        const text = new TextDecoder().decode(chunk);

        // 如果还没有获取到总时长，尝试从FFmpeg输出中提取
        if (!totalDuration) {
            const durationMatch = text.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
            if (durationMatch) {
                const hours = parseInt(durationMatch[1]);
                const minutes = parseInt(durationMatch[2]);
                const seconds = parseFloat(durationMatch[3]);
                totalDuration = hours * 3600 + minutes * 60 + seconds;
            }
        }

        // 提取当前进度
        const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch && totalDuration) {
            const hours = parseInt(timeMatch[1]);
            const minutes = parseInt(timeMatch[2]);
            const seconds = parseFloat(timeMatch[3]);
            const currentTime = hours * 3600 + minutes * 60 + seconds;
            // 计算进度百分比（限制在0-100之间）
            const progress = Math.min(Math.max((currentTime / totalDuration) * 100, 0), 100);
            // progress_cb(progress.toFixed(2));
            progress_cb({ current: currentTime, total: totalDuration });
        }
    };

    // 设置总时长（从选项中获取）
    const setTotalDuration = (duration) => (totalDuration = duration.toString().match(/^\d+:\d+:\d+$/) ? parseDuration(duration) : duration);
    return { handleOutput, setTotalDuration };
}

export default {
    addWatermark,
    sliceVideo,
    extraAudio,
    convertVideoFmt,
    getMetadata,
    getVideoDuration,
    concatVideos,
    autoClipVideos,
    autoCutVideo,
    remvoeAudio,
    getCodecs,
    getAvailableVideoEncoders,
    getAvailableVideoDecoders,
    getAvailableAudioEncoders,
    getAvailableAudioDecoders,
    generateThumbnail,
};
