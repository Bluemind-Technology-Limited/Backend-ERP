#!/bin/bash
# Quick start script for KIB-Apps backend

set -e

echo "🚀 KIB-Apps Backend Quick Start"
echo "================================"

# Step 1: Install dependencies
echo "📦 Installing dependencies..."
cd App
pnpm install

# Step 2: Generate Prisma Client
echo "🔧 Generating Prisma Client..."
pnpm db:generate

# Step 3: Info about .env
echo ""
echo "⚠️  IMPORTANT: Configure your .env file"
echo "   Edit: backend/App/.env"
echo "   Add your Supabase, QStash, and Resend credentials"
echo ""

# Step 4: Seed database (optional - requires real DB credentials)
read -p "Do you want to seed the database now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🌱 Seeding database..."
    pnpm db:seed
else
    echo "⏭️  Skipping database seed (you can run it later with: pnpm db:seed)"
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "To start development server:"
echo "  cd backend"
echo "  pnpm dev"
echo ""
echo "Server will run at: http://localhost:3000"
