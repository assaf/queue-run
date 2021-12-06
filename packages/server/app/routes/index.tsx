import type { LoaderFunction, MetaFunction } from "remix";
import { json, Link, useLoaderData } from "remix";
import { getProjects, Project } from "../database";

export const loader: LoaderFunction = async () => {
  const projects = await getProjects();
  return json(projects);
};

export const meta: MetaFunction = () => {
  return {
    title: "Your projects",
  };
};

export default function Index() {
  const projects = useLoaderData<Project[]>();

  return (
    <main className="space-y-4 my-4">
      <h1 className="font-bold text-lg">Your Projects</h1>
      <ul className="max-w-xs">
        {projects.map((project) => (
          <li
            key={project.id}
            className="border border-gray-300 rounded-md p-4 truncate"
          >
            <Link to={`/projects/${project.id}`} prefetch="intent">
              {project.id}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}