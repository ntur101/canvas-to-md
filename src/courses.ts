/**
 * Which courses to scrape: the ones you're an active *student* in whose term is
 * current (contains today's date). Shared by the course lister and the survey so
 * they can never disagree about the target set.
 */

import type { APIRequestContext } from "playwright";
import { canvasGet, type CanvasCourse, type CanvasEnrollment } from "./canvasApi.js";

/** Your active enrollment role(s) in a course, lowercased (e.g. "student"). */
export function roles(course: CanvasCourse): string[] {
  return (course.enrollments ?? [])
    .filter((e: CanvasEnrollment) => (e.enrollment_state ?? "active") === "active")
    .map((e) => (e.type ?? "?").toLowerCase());
}

export function isStudent(course: CanvasCourse): boolean {
  return roles(course).includes("student");
}

/** True when today falls inside the course's term window (when dates are known). */
export function termIsCurrent(course: CanvasCourse, now: number): boolean {
  const t = course.term;
  if (!t) return false;
  const start = t.start_at ? Date.parse(t.start_at) : NaN;
  const end = t.end_at ? Date.parse(t.end_at) : NaN;
  if (!Number.isNaN(start) && now < start) return false;
  if (!Number.isNaN(end) && now > end) return false;
  return !Number.isNaN(start) || !Number.isNaN(end);
}

/** Fetch all active courses and narrow to the scrape set (student + current term). */
export async function getScrapeCourses(ctx: APIRequestContext): Promise<CanvasCourse[]> {
  const { data } = await canvasGet<CanvasCourse[]>(
    ctx,
    "/api/v1/courses?enrollment_state=active&include[]=term&include[]=enrollments&per_page=100",
  );
  const now = Date.now();
  return data
    .filter((c) => isStudent(c) && termIsCurrent(c, now))
    .sort((a, b) => (a.course_code ?? "").localeCompare(b.course_code ?? ""));
}
