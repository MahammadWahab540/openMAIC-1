import mongoose, { Schema } from 'mongoose';

const ClassroomSchema: Schema = new Schema({
  id: { type: String, required: true, unique: true },
  stage: {
    id: String,
    name: String,
    description: String,
    createdAt: Number,
    updatedAt: Number,
    languageDirective: String,
    style: String,
    whiteboard: [Object],
    agentIds: [String],
    generatedAgentConfigs: [Object],
    interactiveMode: Boolean,
  },
  scenes: [Object],
  createdAt: { type: String, default: () => new Date().toISOString() },
});

export default mongoose.models.Classroom || mongoose.model('Classroom', ClassroomSchema);
