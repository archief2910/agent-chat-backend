import "dotenv/config";

async function main() {
  console.log("Users are created on their first authenticated request, with the configured starting credit grant.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
