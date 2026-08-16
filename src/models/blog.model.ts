import { model, Schema, Document } from 'mongoose';

export interface Blog extends Document {
  title: string;
  slug: string;
  publishedAt: Date;
  readTime: string;
  tags: string[];
  content: string;
}

const blogSchema: Schema = new Schema(
  {
    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    publishedAt: { type: Date, required: true },
    readTime: { type: String, required: true },
    tags: { type: [String], required: true },
    content: { type: String, required: true },
  },
  {
    timestamps: true, // Automatically adds createdAt and updatedAt fields
  }
);

const blogModel = model<Blog>('Blog', blogSchema);

export default blogModel;
