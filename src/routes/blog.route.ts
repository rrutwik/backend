import { Router } from "express";
import { Routes } from "@interfaces/routes.interface";
import BlogController from "@controllers/blog.controller";
import { adminMiddleware } from "@middlewares/admin.middleware";

export class BlogRoute implements Routes {
  public path = "/blogs";
  public router = Router();
  public blogController = new BlogController();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes() {
    // Read APIs (Public)
    this.router.get(`${this.path}`, this.blogController.getBlogs);
    this.router.get(`${this.path}/:slug`, this.blogController.getBlogBySlug);

    // Write APIs (Admin only)
    this.router.post(`${this.path}`, adminMiddleware, this.blogController.createBlog);
  }
}
