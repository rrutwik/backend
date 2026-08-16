import { NextFunction, Request, Response } from "express";
import blogModel from "@models/blog.model";
import { logger } from "@utils/logger";

class BlogController {
  public getBlogs = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 6;
      const search = (req.query.search as string) || "";
      
      const query: any = {};
      
      if (search.trim()) {
        const searchRegex = new RegExp(search.trim(), "i");
        query.$or = [
          { title: { $regex: searchRegex } },
          { excerpt: { $regex: searchRegex } },
          { tags: { $in: [searchRegex] } },
          { content: { $regex: searchRegex } }
        ];
      }

      const totalPosts = await blogModel.countDocuments(query);
      const totalPages = Math.ceil(totalPosts / limit);
      
      const blogs = await blogModel.find(query)
        .sort({ publishedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit);
        
      res.status(200).json({ 
        data: blogs, 
        meta: {
          total: totalPosts,
          page,
          totalPages,
          limit
        },
        message: "findAll" 
      });
    } catch (error) {
      next(error);
    }
  };

  public getBlogBySlug = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const slug = req.params.slug;
      const blog = await blogModel.findOne({ slug });

      if (!blog) {
        return res.status(404).json({ message: "Blog not found" });
      }

      res.status(200).json({ data: blog, message: "findOne" });
    } catch (error) {
      next(error);
    }
  };

  public createBlog = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const blogData = req.body;

      if (!blogData || !blogData.slug || !blogData.title) {
        return res.status(400).json({ message: "Missing required fields: slug and title" });
      }

      logger.info(`Creating/Upserting blog post: ${blogData.slug}`);

      const updatedBlog = await blogModel.findOneAndUpdate(
        { slug: blogData.slug },
        { $set: blogData },
        { new: true, upsert: true }
      );

      res.status(201).json({ data: updatedBlog, message: "created" });
    } catch (error) {
      logger.error(`Error creating blog: ${error}`);
      next(error);
    }
  };
}

export default BlogController;
