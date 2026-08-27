import { Response } from 'express';

export interface ApiError {
  status: number;
  message: string;
  details?: string;
}

/**
 * Centralized error response handler for API routes
 */
export function handleApiError(error: any, res: Response, context: string = 'API Error') {
  console.error(`${context}:`, error);

  // Prisma errors
  if (error?.code === 'P2002') {
    // Unique constraint failed
    const field = error.meta?.target?.[0] || 'field';
    return res.status(409).json({ 
      error: `${field} already exists`,
      code: 'DUPLICATE' 
    });
  }

  if (error?.code === 'P2003') {
    // Foreign key constraint failed
    return res.status(409).json({ 
      error: 'Cannot delete: referenced by other records',
      code: 'FK_VIOLATION' 
    });
  }

  if (error?.code === 'P2025') {
    // Record not found
    return res.status(404).json({ 
      error: 'Record not found',
      code: 'NOT_FOUND' 
    });
  }

  if (error?.code?.startsWith('P')) {
    // Generic Prisma error
    return res.status(500).json({ 
      error: 'Database error',
      code: error.code,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }

  // Standard errors
  if (error instanceof Error) {
    return res.status(500).json({ 
      error: error.message,
      code: 'INTERNAL_ERROR'
    });
  }

  // Unknown error
  return res.status(500).json({ 
    error: 'Unknown error occurred',
    code: 'UNKNOWN_ERROR'
  });
}

/**
 * Validate required fields in request body
 */
export function validateRequired(body: Record<string, any>, fields: string[]): string | null {
  const missing = fields.filter(field => !body[field]);
  if (missing.length > 0) {
    return `Required fields missing: ${missing.join(', ')}`;
  }
  return null;
}
