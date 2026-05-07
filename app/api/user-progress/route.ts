import { NextRequest, NextResponse } from 'next/server';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import connectToDatabase from '@/lib/server/mongodb';
import UserProgress from '@/models/UserProgress';

/**
 * GET /api/user-progress
 * Returns user progress for a specific classroom
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('userId');
  const classroomId = searchParams.get('classroomId');

  if (!userId || !classroomId) {
    return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'Missing userId or classroomId');
  }

  try {
    await connectToDatabase();
    const progress = await UserProgress.findOne({ userId, classroomId }).lean();
    return apiSuccess(progress ? { progress } : { progress: { completedScenes: [], quizResults: [] } });
  } catch (error) {
    console.error('Failed to get user progress:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Internal Server Error');
  }
}

/**
 * POST /api/user-progress
 * Updates user progress for a specific classroom
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId, classroomId, completedScenes, quizResult } = body;

    if (!userId || !classroomId) {
      return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'Missing userId or classroomId');
    }

    await connectToDatabase();

    const update: any = {};
    const addToSet: any = {};
    const push: any = {};

    if (completedScenes && Array.isArray(completedScenes)) {
      addToSet.completedScenes = { $each: completedScenes };
    }

    if (quizResult) {
      push.quizResults = quizResult;
    }

    const updateObj: any = {
      lastAccessedAt: new Date(),
    };

    if (Object.keys(addToSet).length > 0) {
      updateObj.$addToSet = addToSet;
    }
    if (Object.keys(push).length > 0) {
      updateObj.$push = push;
    }

    const progress = await UserProgress.findOneAndUpdate(
      { userId, classroomId },
      updateObj,
      { upsert: true, new: true }
    );

    return apiSuccess({ progress });
  } catch (error) {
    console.error('Failed to update user progress:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Internal Server Error');
  }
}
