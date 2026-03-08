import express from "express"
import multer from "multer"
import cloudinary from "../config/cloudinary.js"
import { supabaseAdmin } from "../config/supabase.js"
import { requireAuth } from "../middleware/auth.js"

const router = express.Router()

// Use memory storage so multer gives us a buffer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true)
    else cb(new Error("Only image files are allowed"))
  },
})

// ── POST /api/upload/avatar ────────────────────────────────
router.post("/avatar", requireAuth, upload.single("avatar"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" })

    // Upload to Cloudinary
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          folder:         "lorri/avatars",
          public_id:      `user_${req.user.id}`,
          overwrite:      true,
          transformation: [{ width: 200, height: 200, crop: "fill", gravity: "face" }],
        },
        (error, result) => {
          if (error) reject(error)
          else resolve(result)
        }
      ).end(req.file.buffer)
    })

    // Save URL to profile
    await supabaseAdmin
      .from("profiles")
      .update({ avatar_url: result.secure_url })
      .eq("id", req.user.id)

    res.json({ avatar_url: result.secure_url })
  } catch (err) {
    console.error("Avatar upload error:", err)
    res.status(500).json({ error: "Upload failed" })
  }
})

export default router