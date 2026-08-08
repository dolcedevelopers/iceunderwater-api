import type { FastifyError, FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";
import fp from "./fp.js";

const errorPlugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error: FastifyError | AppError | ZodError | Error, request, reply) => {
    const requestId = request.id;

    if (error instanceof ZodError) {
      return reply.status(400).send({
        status: 400,
        code: "VALIDATION_ERROR",
        message: error.issues[0]?.message || "Invalid request.",
        requestId,
      });
    }

    if (error instanceof AppError) {
      return reply.status(error.status).send({
        status: error.status,
        code: error.code,
        message: error.expose ? error.message : "Something went wrong.",
        requestId,
      });
    }

    const status = "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    request.log.error({ err: error, requestId }, "unhandled error");
    return reply.status(status).send({
      status,
      code: status === 429 ? "RATE_LIMITED" : "INTERNAL_ERROR",
      message: status === 429 ? "Too many requests. Please try again later." : "Something went wrong.",
      requestId,
    });
  });
};

export default fp(errorPlugin, { name: "error-handler" });
