import { createFileRoute } from "@tanstack/react-router";
import { LoginPage } from "./-LoginPage";

export const Route = createFileRoute("/login")({ component: LoginPage });
