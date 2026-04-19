import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import path from "path";
import multer from "multer";
import { exec, execSync } from "child_process";
import { v4 as uuidv4 } from "uuid";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import ffprobePath from "@ffprobe-installer/ffprobe";
import ffmpeg from "fluent-ffmpeg";
import AdmZip from "adm-zip";
import { GoogleGenAI, Type } from "@google/genai";

ffmpeg.setFfmpegPath(ffmpegPath.path);
ffmpeg.setFfprobePath(ffprobePath.path);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

let isPySceneDetectAvailable = true;
try {
    execSync("scenedetect --version", { stdio: 'ignore' });
} catch (e) {
    try {
        execSync("python3 -m scenedetect --version", { stdio: 'ignore' });
    } catch (e2) {
        isPySceneDetectAvailable = false;
        console.info("PySceneDetect not found. Scene detection will use high-compatibility FFmpeg mode.");
    }
}

// Setup directories
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const OUTPUT_DIR = path.join(process.cwd(), "output");
const FRAMES_DIR = path.join(OUTPUT_DIR, "frames");

[UPLOADS_DIR, OUTPUT_DIR, FRAMES_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage });

// API routes
app.post("/api/upload-supabase", express.json(), async (req, res) => {
  const { url, fileName, id } = req.body;
  if (!url) return res.status(400).json({ error: "No URL provided." });

  const finalFileName = id ? `${id}${path.extname(fileName || 'video.mp4')}` : (fileName || `${uuidv4()}.mp4`);
  const videoPath = path.join(UPLOADS_DIR, finalFileName);

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch video: ${response.statusText}`);
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(videoPath, buffer);

    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      let fps = 30;
      if (!err && metadata && metadata.streams) {
        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        if (videoStream && videoStream.avg_frame_rate) {
          const [num, den] = videoStream.avg_frame_rate.split('/').map(Number);
          if (num && den) {
            fps = Math.round(num / den);
          }
        }
      }

      res.json({
        id: path.parse(finalFileName).name,
        originalName: fileName,
        size: buffer.length,
        path: finalFileName,
        fps: fps
      });
    });
  } catch (err: any) {
    console.error("Supabase download error:", err);
    res.status(500).json({ error: "Failed to process Supabase video", details: err.message });
  }
});

app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No video file provided." });
  }

  const videoPath = path.join(UPLOADS_DIR, req.file.filename);
  
  ffmpeg.ffprobe(videoPath, (err, metadata) => {
    let fps = 30; // default fallback
    if (!err && metadata && metadata.streams) {
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      if (videoStream && videoStream.avg_frame_rate) {
        const [num, den] = videoStream.avg_frame_rate.split('/').map(Number);
        if (num && den) {
          fps = Math.round(num / den);
        }
      }
    }

    res.json({
      id: path.parse(req.file!.filename).name,
      originalName: req.file!.originalname,
      size: req.file!.size,
      path: req.file!.filename,
      fps: fps
    });
  });
});

app.post("/api/detect", express.json(), async (req, res) => {
  const { id, threshold, detector = 'adaptive' } = req.body;
  if (!id) return res.status(400).json({ error: "Video ID is required." });

  const inputFiles = fs.readdirSync(UPLOADS_DIR).filter(f => f.startsWith(id));
  if (inputFiles.length === 0) return res.status(404).json({ error: "Video not found." });
  
  const videoFile = inputFiles[0];
  const videoPath = path.join(UPLOADS_DIR, videoFile);
  const csvPath = path.join(OUTPUT_DIR, `${id}-Scenes.csv`);

  const runPySceneDetect = () => {
    return new Promise<any[]>((resolve, reject) => {
        if (!isPySceneDetectAvailable) {
            return reject(new Error("PySceneDetect not available on system"));
        }

        // Determine detector and threshold
        let detectorCmd = "detect-adaptive";
        let defaultThreshold = 2.8;
        
        if (detector === "content") {
          detectorCmd = "detect-content";
          defaultThreshold = 30;
        }
        
        const activeThreshold = threshold !== undefined ? threshold : defaultThreshold;

        const tryCommand = (cmd: string) => {
            const fullCmd = `${cmd} -i "${videoPath}" -d "${OUTPUT_DIR}" list-scenes ${detectorCmd} -t ${activeThreshold}`;
            console.log("Attempting scene detection:", fullCmd);
            
            const ffmpegDir = path.dirname(ffmpegPath.path);
            const env = { 
                ...process.env, 
                PATH: `${ffmpegDir}:${path.dirname(ffprobePath.path)}:/usr/local/bin:/usr/bin:/bin:${process.env.PATH}` 
            };
            
            exec(fullCmd, { env }, (error, stdout, stderr) => {
                if (fs.existsSync(csvPath)) {
                    try {
                        const csvContent = fs.readFileSync(csvPath, "utf-8");
                        const lines = csvContent.split("\n");
                        let startIdx = lines.findIndex(l => l.startsWith("Scene Number"));
                        if(startIdx === -1) startIdx = 1;
                        
                        const scenes = [];
                        for (let i = startIdx + 1; i < lines.length; i++) {
                            const line = lines[i].trim();
                            if (!line) continue;
                            const parts = line.split(",");
                            if (parts.length >= 10) {
                                scenes.push({
                                    index: parseInt(parts[0]),
                                    start_time: parts[3].trim(),
                                    end_time: parts[6].trim(),
                                    start_timecode: parts[2].trim(),
                                    end_timecode: parts[5].trim()
                                });
                            }
                        }
                        resolve(scenes);
                    } catch (e) {
                        reject(e);
                    }
                } else if (cmd === "scenedetect") {
                    tryCommand("python3 -m scenedetect");
                } else {
                    const errStr = stderr || String(error);
                    let cleanError = new Error("PySceneDetect execution failed");
                    if (errStr.includes("No module named scenedetect") || errStr.includes("command not found")) {
                        isPySceneDetectAvailable = false;
                        cleanError = new Error("PySceneDetect module missing from environment");
                        console.warn("PySceneDetect module missing. System is automatically switching to High-Compatibility FFmpeg fallback.");
                    }
                    reject(cleanError);
                }
            });
        };

        tryCommand("scenedetect");
    });
  };

  const runFfmpegFallback = () => {
    return new Promise<any[]>((resolve, reject) => {
        // Determine detector and threshold
        let defaultThreshold = 2.8;
        if (detector === "content") {
          defaultThreshold = 30;
        }
        const activeThreshold = threshold !== undefined ? threshold : defaultThreshold;

        // Map the threshold to FFmpeg's 0.0 - 1.0 range
        // For Content/ContentDetector (default 30): 30 -> 0.3
        // For Adaptive (default 2.8): 2.8 -> 0.4 (approx)
        let ffmpegThreshold = 0.3;
        if (detector === "content") {
            ffmpegThreshold = activeThreshold / 100;
        } else {
            // Mapping for adaptive: 2.8 -> 0.35, 1.5 -> 0.18
            ffmpegThreshold = (activeThreshold / 2.8) * 0.35;
        }
        
        // Clamp to safe ranges
        ffmpegThreshold = Math.max(0.05, Math.min(0.8, ffmpegThreshold));

        console.log(`Using FFMPEG fallback with threshold: ${ffmpegThreshold.toFixed(2)} (mapped from ${activeThreshold})`);
        
        const command = `"${ffmpegPath.path}" -i "${videoPath}" -filter:v "select='gt(scene,${ffmpegThreshold})',showinfo" -f null -`;
        exec(command, (error, stdout, stderr) => {
            const output = stderr || stdout;
            const lines = output.split('\n').filter(l => l.includes('pts_time:'));
            const scenes: any[] = [];
            let lastTime = 0;
            
            ffmpeg.ffprobe(videoPath, (ffprobeErr, metadata) => {
                if (ffprobeErr) return reject(ffprobeErr);
                
                const duration = Number(metadata?.format?.duration) || 10;
                lines.forEach((line, i) => {
                    const match = line.match(/pts_time:([0-9.]+)/);
                    if (match) {
                        const time = parseFloat(match[1]);
                        if (time > lastTime + 0.5) { // Min 0.5s scene
                            scenes.push({
                                index: scenes.length + 1,
                                start_time: lastTime.toFixed(3),
                                end_time: time.toFixed(3),
                                start_timecode: formatTimecode(lastTime),
                                end_timecode: formatTimecode(time)
                            });
                            lastTime = time;
                        }
                    }
                });
                // Add the last scene
                if (duration > lastTime) {
                    scenes.push({
                        index: scenes.length + 1,
                        start_time: lastTime.toFixed(3),
                        end_time: duration.toFixed(3),
                        start_timecode: formatTimecode(lastTime),
                        end_timecode: formatTimecode(duration)
                    });
                }
                resolve(scenes);
            });
        });
    });
  };

  try {
    if (isPySceneDetectAvailable) {
        try {
            const scenes = await runPySceneDetect();
            return res.json({ scenes, method: 'PySceneDetect' });
        } catch (err: any) {
            console.warn("PySceneDetect failed during execution, falling back to FFmpeg:", err.message || err);
        }
    }
    
    // Fallback path
    try {
        const scenes = await runFfmpegFallback();
        res.json({ scenes, method: 'FFmpeg-Fallback' });
    } catch (fallbackErr: any) {
        console.error("FFmpeg fallback also failed:", fallbackErr);
        res.status(500).json({ error: "Scene detection failed", details: String(fallbackErr) });
    }
  } catch (err: any) {
    res.status(500).json({ error: "Unhandled error during detection", details: String(err) });
  }
});

function formatTimecode(seconds: number) {
    const d = new Date(seconds * 1000);
    return `00:${d.getUTCMinutes().toString().padStart(2, '0')}:${d.getUTCSeconds().toString().padStart(2, '0')}.${d.getUTCMilliseconds().toString().padStart(3, '0')}`;
}

app.post("/api/clip", express.json(), async (req, res) => {
  const { id, clips } = req.body;
  if (!id || !clips || !Array.isArray(clips)) {
    return res.status(400).json({ error: "Invalid parameters" });
  }

  const inputFiles = fs.readdirSync(UPLOADS_DIR).filter(f => f.startsWith(id));
  if (inputFiles.length === 0) return res.status(404).json({ error: "Video not found." });
  const videoPath = path.join(UPLOADS_DIR, inputFiles[0]);

  try {
    const outputFiles: string[] = [];
    const runFfmpeg = (start: string, end: string, index: number) => {
        return new Promise<string>((resolve, reject) => {
            const outPath = path.join(OUTPUT_DIR, `${id}-clip-${index}.mp4`);
            
            // Calculate duration and trim 0.04s (approx 1 frame) to avoid "leaking" into the next scene
            const startTime = parseFloat(start);
            const endTime = parseFloat(end);
            const duration = Math.max(0.1, endTime - startTime - 0.04).toFixed(3);

            // High-quality encoding: crf 17 is visually lossless, preset slow for better efficiency, no audio (-an)
            // Using -t (duration) instead of -to (end point) for better stability across frame boundaries
            const cmd = `"${ffmpegPath.path}" -i "${videoPath}" -ss ${start} -t ${duration} -c:v libx264 -crf 17 -preset slow -an "${outPath}" -y`;
            exec(cmd, (error) => {
                if(error) reject(error);
                else resolve(outPath);
            });
        });
    };

    // Sequential processing as requested: "Process clips sequentially"
    const results = [];
    for (const clip of clips) {
        const outPath = await runFfmpeg(clip.start_time, clip.end_time, clip.index);
        results.push(path.basename(outPath));
    }

    res.json({ results });
  } catch (err: any) {
    res.status(500).json({ error: "Clip generation failed", details: err.message });
  }
});

app.post("/api/frames/extract", express.json(), async (req, res) => {
    const { id, fps = 5 } = req.body; // Default to 5fps if not specified to avoid massive output initially
    if (!id) return res.status(400).json({ error: "Video ID is required." });

    const inputFiles = fs.readdirSync(UPLOADS_DIR).filter(f => f.startsWith(id));
    if (inputFiles.length === 0) return res.status(404).json({ error: "Video not found." });
    const videoPath = path.join(UPLOADS_DIR, inputFiles[0]);

    const videoFramesDir = path.join(FRAMES_DIR, id);
    if (!fs.existsSync(videoFramesDir)) fs.mkdirSync(videoFramesDir, { recursive: true });

    // Use FFmpeg for high-quality JPG extraction
    // -vf fps=N extracts frames at N frames per second
    // -q:v 2 is a high quality setting for JPEGs (1-31, lower is better)
    // Using %04d for ordered filenames
    const cmd = `"${ffmpegPath.path}" -i "${videoPath}" -vf "fps=${fps}" -start_number 1 -q:v 2 "${videoFramesDir}/frame_%04d.jpg" -y`;
    
    console.log(`Extracting frames for ${id} at ${fps}fps...`);
    exec(cmd, (error) => {
        if (error) {
            console.error("Frame extraction failed:", error);
            return res.status(500).json({ error: "Frame extraction failed", details: error.message });
        }

        const frames = fs.readdirSync(videoFramesDir)
            .filter(f => f.endsWith('.jpg'))
            .sort()
            .map(f => `/output/frames/${id}/${f}`);
        
        res.json({ frames, count: frames.length });
    });
});

app.get("/api/download/zip", (req, res) => {
    const { id, clips } = req.query;
    if (!id || !clips) return res.status(400).json({ error: "Invalid parameters" });
    const clipNames = (clips as string).split(',');
    
    const zip = new AdmZip();
    for (const name of clipNames) {
        const clipPath = path.join(OUTPUT_DIR, name);
        if (fs.existsSync(clipPath)) {
            zip.addLocalFile(clipPath);
        }
    }
    const zipBuffer = zip.toBuffer();
    
    // Explicit headers for ZIP delivery
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${id}-clips.zip"`);
    res.setHeader('Content-Length', zipBuffer.length.toString());
    res.send(zipBuffer);
});

app.get("/api/download/:filename", (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(OUTPUT_DIR, filename);
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        return res.status(404).json({ error: "File not found" });
    }
    
    const isZip = filename.endsWith('.zip');
    const contentType = isZip ? 'application/zip' : 'video/mp4';
    
    // Explicit headers for binary delivery
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    res.sendFile(filePath, (err) => {
        if (err) {
            console.error("Error sending file:", err);
            if (!res.headersSent) {
                res.status(500).json({ error: "Failed to stream file" });
            }
        }
    });
});

// Serve videos for preview
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/output", express.static(OUTPUT_DIR));

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Global Error Handler to avoid sending HTML error pages to JSON parsers
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("Express Error:", err);
    res.status(500).json({ error: "Internal Server Error", message: err.message });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
