import {
  GET as sharedGET,
  POST as sharedPOST,
} from "../shared-market-dispatch/route";

export const runtime = "nodejs";

// Compatibility endpoint; all work uses the one shared dispatcher.
export async function GET(request: Request) {
  return sharedGET(request);
}

export async function POST(request: Request) {
  return sharedPOST(request);
}
