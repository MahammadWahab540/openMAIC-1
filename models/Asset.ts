import mongoose, { Schema } from 'mongoose';

const AssetSchema: Schema = new Schema({
  id: { type: String, required: true, unique: true },
  filename: String,
  contentType: String,
  size: Number,
  metadata: Object,
  // If not using GridFS, we could store binary as Buffer (only for small files < 16MB)
  // But for slides/videos, GridFS is better.
  // For now, this model serves as a registry for assets.
}, { timestamps: true });

export default mongoose.models.Asset || mongoose.model('Asset', AssetSchema);
