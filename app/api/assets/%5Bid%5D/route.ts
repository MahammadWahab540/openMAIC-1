import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectToDatabase from '@/lib/server/mongodb';
import { apiError, API_ERROR_CODES } from '@/lib/server/api-response';

/**
 * GET /api/assets/[id]
 * Retrieves an asset from GridFS
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const conn = await connectToDatabase();
    const db = conn.connection.db;
    if (!db) throw new Error('Database not connected');

    const bucket = new mongoose.mongo.GridFSBucket(db, {
      bucketName: 'assets',
    });

    // Find the file metadata first to get the content type
    const files = await bucket.find({ filename: id }).toArray();
    if (files.length === 0) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Asset not found');
    }

    const file = files[0];
    const downloadStream = bucket.openDownloadStreamByName(id);

    // Stream the data to the response
    const stream = new ReadableStream({
      async start(controller) {
        for await (const chunk of downloadStream) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    return new NextResponse(stream, {
      headers: {
        'Content-Type': file.contentType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': file.length.toString(),
      },
    });
  } catch (error) {
    console.error('Asset retrieval failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Internal Server Error');
  }
}

/**
 * POST /api/assets/[id]
 * Uploads an asset to GridFS
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const conn = await connectToDatabase();
    const db = conn.connection.db;
    if (!db) throw new Error('Database not connected');

    const bucket = new mongoose.mongo.GridFSBucket(db, {
      bucketName: 'assets',
    });

    const contentType = req.headers.get('content-type') || 'application/octet-stream';
    const body = await req.arrayBuffer();
    const buffer = Buffer.from(body);

    // Delete existing asset with same name if it exists
    const existingFiles = await bucket.find({ filename: id }).toArray();
    for (const file of existingFiles) {
      await bucket.delete(file._id);
    }

    const uploadStream = bucket.openUploadStream(id, {
      contentType,
      metadata: {
        uploadedAt: new Date(),
      },
    });

    await new Promise((resolve, reject) => {
      uploadStream.end(buffer, (error) => {
        if (error) reject(error);
        else resolve(true);
      });
    });

    return NextResponse.json({ success: true, id });
  } catch (error) {
    console.error('Asset upload failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Internal Server Error');
  }
}
