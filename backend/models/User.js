import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true },
    username: String,
    firstName: String,
    joinedAt: { type: Date, default: Date.now },
    lastActive: { type: Date, default: Date.now },
    messageCount: { type: Number, default: 0 },
});

export default mongoose.model('User', userSchema);