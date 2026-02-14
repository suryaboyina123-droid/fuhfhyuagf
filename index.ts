import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function callAI(messages: Array<{ role: string; content: string }>, tools?: any[], tool_choice?: any) {
  const body: any = {
    model: "google/gemini-3-flash-preview",
    messages,
  };
  if (tools) body.tools = tools;
  if (tool_choice) body.tool_choice = tool_choice;

  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("AI error:", response.status, text);
    if (response.status === 429) throw new Error("Rate limit exceeded");
    if (response.status === 402) throw new Error("Payment required");
    throw new Error(`AI error: ${response.status}`);
  }

  return await response.json();
}

async function handleTriage(patient: any) {
  const prompt = `You are a medical triage AI. Analyze the following patient data and classify their risk level, recommend a department, and explain your reasoning.

Patient Data:
- Age: ${patient.age}
- Gender: ${patient.gender}
- Symptoms: ${patient.symptoms.join(", ")}
${patient.symptoms_text ? `- Additional symptoms: ${patient.symptoms_text}` : ""}
${patient.blood_pressure ? `- Blood Pressure: ${patient.blood_pressure}` : ""}
${patient.heart_rate ? `- Heart Rate: ${patient.heart_rate} bpm` : ""}
${patient.temperature ? `- Temperature: ${patient.temperature}°F` : ""}
${patient.pre_existing_conditions?.length ? `- Pre-existing Conditions: ${patient.pre_existing_conditions.join(", ")}` : ""}

Provide your analysis using the triage_result function.`;

  const tools = [
    {
      type: "function",
      function: {
        name: "triage_result",
        description: "Return the triage classification result for a patient.",
        parameters: {
          type: "object",
          properties: {
            risk_level: { type: "string", enum: ["Low", "Medium", "High"] },
            confidence_score: { type: "number", description: "Confidence percentage 0-100" },
            recommended_department: {
              type: "string",
              enum: ["Emergency", "Cardiology", "Neurology", "General Medicine", "Pulmonology", "Gastroenterology", "Orthopedics", "Endocrinology", "Nephrology", "Oncology"],
            },
            contributing_factors: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  factor: { type: "string" },
                  weight: { type: "string", description: "e.g. 'High impact', 'Moderate', 'Minor'" },
                },
                required: ["factor", "weight"],
              },
            },
            explanation: { type: "string", description: "A 2-3 sentence explanation of the triage decision" },
          },
          required: ["risk_level", "confidence_score", "recommended_department", "contributing_factors", "explanation"],
        },
      },
    },
  ];

  const result = await callAI(
    [{ role: "user", content: prompt }],
    tools,
    { type: "function", function: { name: "triage_result" } }
  );

  const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("AI did not return structured triage result");

  return JSON.parse(toolCall.function.arguments);
}

async function handleParseDocument(filePath: string) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: fileData, error: downloadError } = await supabase.storage
    .from("health-documents")
    .download(filePath);

  if (downloadError) throw downloadError;

  // Convert to base64 for AI processing
  const bytes = await fileData.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const mimeType = filePath.endsWith(".pdf") ? "application/pdf" : "image/jpeg";

  const prompt = `Extract structured patient medical data from this document. Look for: age, gender, symptoms, blood pressure, heart rate, temperature, and pre-existing conditions.`;

  const tools = [
    {
      type: "function",
      function: {
        name: "extracted_patient_data",
        description: "Structured patient data extracted from a medical document.",
        parameters: {
          type: "object",
          properties: {
            age: { type: "number" },
            gender: { type: "string" },
            symptoms: { type: "array", items: { type: "string" } },
            blood_pressure: { type: "string" },
            heart_rate: { type: "number" },
            temperature: { type: "number" },
            pre_existing_conditions: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  ];

  const result = await callAI(
    [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
        ] as any,
      },
    ],
    tools,
    { type: "function", function: { name: "extracted_patient_data" } }
  );

  const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) return { parsed: null };

  return { parsed: JSON.parse(toolCall.function.arguments) };
}

async function handleGenerateSynthetic() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const prompt = `Generate 8 realistic synthetic patient records for a hospital triage system. Each patient should have varied demographics, symptoms, vitals, and conditions. Make some high risk, some medium, and some low.`;

  const tools = [
    {
      type: "function",
      function: {
        name: "synthetic_patients",
        description: "Return an array of synthetic patient records with triage results.",
        parameters: {
          type: "object",
          properties: {
            patients: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  age: { type: "number" },
                  gender: { type: "string", enum: ["Male", "Female", "Other"] },
                  symptoms: { type: "array", items: { type: "string" } },
                  blood_pressure: { type: "string" },
                  heart_rate: { type: "number" },
                  temperature: { type: "number" },
                  pre_existing_conditions: { type: "array", items: { type: "string" } },
                  risk_level: { type: "string", enum: ["Low", "Medium", "High"] },
                  confidence_score: { type: "number" },
                  recommended_department: { type: "string" },
                  contributing_factors: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        factor: { type: "string" },
                        weight: { type: "string" },
                      },
                      required: ["factor", "weight"],
                    },
                  },
                  ai_explanation: { type: "string" },
                },
                required: ["age", "gender", "symptoms", "risk_level", "confidence_score", "recommended_department", "contributing_factors", "ai_explanation"],
              },
            },
          },
          required: ["patients"],
        },
      },
    },
  ];

  const result = await callAI(
    [{ role: "user", content: prompt }],
    tools,
    { type: "function", function: { name: "synthetic_patients" } }
  );

  const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("Failed to generate synthetic data");

  const { patients } = JSON.parse(toolCall.function.arguments);

  const { error } = await supabase.from("patients").insert(
    patients.map((p: any) => ({
      age: p.age,
      gender: p.gender,
      symptoms: p.symptoms,
      blood_pressure: p.blood_pressure || null,
      heart_rate: p.heart_rate || null,
      temperature: p.temperature || null,
      pre_existing_conditions: p.pre_existing_conditions || [],
      risk_level: p.risk_level,
      confidence_score: p.confidence_score,
      recommended_department: p.recommended_department,
      contributing_factors: p.contributing_factors,
      ai_explanation: p.ai_explanation,
    }))
  );

  if (error) throw error;
  return { success: true, count: patients.length };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { action, patient, filePath } = await req.json();

    let result;
    switch (action) {
      case "triage":
        result = await handleTriage(patient);
        break;
      case "parse-document":
        result = await handleParseDocument(filePath);
        break;
      case "generate-synthetic":
        result = await handleGenerateSynthetic();
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("triage-ai error:", e);
    const status = e.message?.includes("Rate limit") ? 429 : e.message?.includes("Payment") ? 402 : 500;
    return new Response(JSON.stringify({ error: e.message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
