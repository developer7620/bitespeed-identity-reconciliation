import { Router } from "express";
import { prisma } from "../lib/prisma";
import { ContactRepository } from "../repositories/contactRepository";
import { IdentityService } from "../services/identityService";
import { IdentifyController } from "../controllers/identifyController";

// ── Dependency injection wired here ──────────────────────────────────────────
// Constructing dependencies at the route level keeps each layer independently
// testable (tests can inject mocks without touching the router).
const repo = new ContactRepository(prisma);
const service = new IdentityService(repo);
const controller = new IdentifyController(service);

export const identifyRouter = Router();

identifyRouter.post("/", controller.handle);
