import mongoose, { Schema } from 'mongoose';

const UserProgressSchema: Schema = new Schema({
  userId: { type: String, required: true },
  classroomId: { type: String, required: true },
  completedScenes: [String], // Array of scene IDs
  quizResults: [
    {
      sceneId: String,
      score: Number,
      total: Number,
      answers: [Object],
      completedAt: { type: Date, default: Date.now },
    }
  ],
  lastAccessedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// Ensure unique progress record per user per classroom
UserProgressSchema.index({ userId: 1, classroomId: 1 }, { unique: true });

export default mongoose.models.UserProgress || mongoose.model('UserProgress', UserProgressSchema);
